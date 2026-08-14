// Is that process WORKING, or just ALIVE?
//
//   node liveness.mjs <pid> [sampleSeconds]
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS - a single `ps` reading answers the wrong question
//
// 2026-08-13: a preview deploy sat for 1h25m on what is a ~7 minute job. Checked with `ps` it looked
// healthy - 19 minutes of CPU time, 30% in the %CPU column, hundreds of MB resident. Every one of
// those numbers is CUMULATIVE OR AVERAGED SINCE THE PROCESS STARTED. They say "it worked once".
// They cannot say "it is working now".
//
// The owner caught it by sampling twice: CPU went 19:23 -> 19:31 across 21 minutes, i.e. 8 seconds
// of work in 21 minutes of wall clock. Dead, while looking busy.
//
// So liveness is a DERIVATIVE. One reading is a position; you need two to get a velocity.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY /proc AND NOT `ps %CPU`
//
// `ps`'s %CPU is the average over the process's whole lifetime, so a process that burned 20 minutes
// of CPU and then wedged still reports a healthy-looking percentage for hours. /proc/<pid>/stat's
// utime+stime are raw counters covering every thread in the group, which is what a delta needs.

import { readFileSync } from 'node:fs';

const HZ = 100;   // USER_HZ; getconf CLK_TCK is 100 on every Linux this project runs on

/** Cumulative CPU ticks (user + system) for a pid, across ALL its threads. */
export function cpuTicks(pid) {
  // Field 14 = utime, 15 = stime, 1-indexed AFTER the comm field. comm can contain spaces and
  // parentheses, so the split starts after the LAST ')' rather than at the first space.
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(rest[11]) + Number(rest[12]);   // utime, stime (0-indexed from field 3)
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Bytes this process has moved through read()/write() syscalls - INCLUDING sockets.
 *
 * The second signal, and the reason this tool no longer says "HUNG" on its own. A process blocked on
 * a slow network read burns ZERO CPU, exactly like a wedged one. CPU alone cannot tell them apart,
 * and calling a healthy sync "HUNG" would get it killed for doing its job.
 *
 * rchar/wchar count bytes at the syscall boundary, so a chatty sync moves them even while CPU is
 * flat. /proc/<pid>/io is unreadable for processes you do not own - treated as "unknown", never as
 * "no activity", because absence of a reading is not a reading of absence.
 */
export function ioBytes(pid) {
  try {
    const io = readFileSync(`/proc/${pid}/io`, 'utf8');
    const num = (k) => Number(/^\s*$/.test(io) ? 0 : (io.match(new RegExp(`^${k}:\\s*(\\d+)`, 'm'))?.[1] ?? 0));
    return { rchar: num('rchar'), wchar: num('wchar'), ok: true };
  } catch { return { rchar: 0, wchar: 0, ok: false }; }
}

/**
 * Sample twice and report whether the process actually moved.
 *
 * `movingIfSeconds` is the threshold in CPU-seconds over the sample window. A working prover burns
 * whole cores; a wedged one burns effectively nothing. The gap between those is wide, so the
 * threshold does not need to be clever - but it must not be ZERO, or a stray timer tick reads as
 * progress.
 */
export async function sampleCpu(pid, sampleSeconds = 30, movingIfSeconds = 0.5) {
  if (!alive(pid)) return { pid, alive: false, verdict: 'GONE' };
  const c0 = cpuTicks(pid), i0 = ioBytes(pid);
  await new Promise((r) => setTimeout(r, sampleSeconds * 1000));
  if (!alive(pid)) return { pid, alive: false, verdict: 'EXITED DURING SAMPLE' };
  const c1 = cpuTicks(pid), i1 = ioBytes(pid);

  const cpuSeconds = (c1 - c0) / HZ;
  const ioDelta = (i1.rchar - i0.rchar) + (i1.wchar - i0.wchar);
  const ioReadable = i0.ok && i1.ok;

  // THREE outcomes, not two - this tool used to collapse the middle one into "HUNG".
  //
  //   WORKING       CPU moved. Unambiguous.
  //   IO-WAIT       CPU flat, but bytes moved. A network wait, not a wedge. Killing this kills a
  //                 healthy sync.
  //   NO PROGRESS   CPU flat AND no bytes moved. Still NOT proof of a hang: a process blocked on a
  //                 socket that will never answer looks exactly like one that is wedged, from the
  //                 outside. That is a limit of external observation, so the verdict says so and
  //                 points at the only thing that can settle it - an application-level heartbeat
  //                 (preview-deploy.mjs prints one every 15s: beats continuing means the event loop
  //                 is alive and we are waiting on the network).
  const verdict = cpuSeconds >= movingIfSeconds ? 'WORKING'
                : (ioReadable && ioDelta > 0) ? 'IO-WAIT'
                : 'NO PROGRESS';

  return {
    pid, alive: true, sampleSeconds, cpuSeconds,
    cumulativeCpuSeconds: c1 / HZ,
    ioBytesDelta: ioReadable ? ioDelta : null,
    ioReadable,
    verdict,
    note: verdict === 'NO PROGRESS'
      ? 'CPU flat and no I/O. This CANNOT distinguish a wedged process from one blocked on a socket ' +
        'that will never answer. Check the app heartbeat before killing it.'
      : verdict === 'IO-WAIT'
      ? 'No CPU, but bytes are moving - a network wait. Do NOT kill this.'
      : undefined,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pid = Number(process.argv[2]);
  const secs = Number(process.argv[3] ?? 30);
  if (!pid) { console.error('usage: node liveness.mjs <pid> [sampleSeconds]'); process.exit(2); }
  const r = await sampleCpu(pid, secs);
  console.log(JSON.stringify(r, null, 2));
  // Exit code carries the verdict so a wrapper can branch on it without parsing:
  //   0 WORKING · 1 NO PROGRESS · 2 IO-WAIT · 3 GONE
  process.exit(r.verdict === 'WORKING' ? 0 : r.verdict === 'NO PROGRESS' ? 1
             : r.verdict === 'IO-WAIT' ? 2 : 3);
}
