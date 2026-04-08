/**
 * Simple Profiler Utility (Summary Mode)
 * 
 * Tracks function runtimes and prints a consolidated table to the console.
 * This mimics Python's cProfile summary.
 */

interface ProfileStat {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
}

const stats: Record<string, ProfileStat> = {};
const LAST_PRINT_TIME = 0;
const PRINT_INTERVAL_MS = 5000; // Print table every 5 seconds
let timerId: ReturnType<typeof setInterval> | null = null;

const updateStat = (label: string, durationMs: number) => {
    if (!stats[label]) {
        stats[label] = { count: 0, totalMs: 0, minMs: Number.MAX_VALUE, maxMs: 0 };
    }
    const s = stats[label];
    s.count++;
    s.totalMs += durationMs;
    s.minMs = Math.min(s.minMs, durationMs);
    s.maxMs = Math.max(s.maxMs, durationMs);
};

export const printStats = () => {
    // const table = Object.entries(stats).map(([label, s]) => ({
    //     Function: label,
    //     Count: s.count,
    //     'Avg(ms)': (s.totalMs / s.count).toFixed(2),
    //     'Total(ms)': s.totalMs.toFixed(0),
    //     'Max(ms)': s.maxMs.toFixed(2),
    // }));
    // if (table.length > 0) {
    //     console.log('\n📊 === PERFORMANCE REPORT ===');
    //     console.log('| Function                | Count | Avg(ms) | Max(ms) | Total(s) |');
    //     console.log('|-------------------------|-------|---------|---------|----------|');
    //     table.forEach(row => {
    //         const name = row.Function.padEnd(23).slice(0, 23);
    //         const count = String(row.Count).padEnd(5);
    //         const avg = String(row['Avg(ms)']).padEnd(7);
    //         const max = String(row['Max(ms)']).padEnd(7);
    //         const total = (parseFloat(row['Total(ms)']) / 1000).toFixed(2).padEnd(8);
    //         console.log(`| ${name} | ${count} | ${avg} | ${max} | ${total} |`);
    //     });
    //     console.log('=============================\n');
    // }
    return;
};

// Auto-start printer
if (!timerId) {
    timerId = setInterval(printStats, PRINT_INTERVAL_MS);
}

export const startTimer = (label: string) => {
    const start = global.performance.now();
    return () => {
        const end = global.performance.now();
        const duration = end - start;
        updateStat(label, duration);
        return duration;
    };
};

export const withProfiling = <T extends (...args: any[]) => any>(
    label: string,
    func: T
): T => {
    return ((...args: any[]) => {
        const start = global.performance.now();
        const result = func(...args);

        // Handle Promises (async functions)
        if (result instanceof Promise) {
            return result.then((res) => {
                const end = global.performance.now();
                updateStat(label, end - start);
                return res;
            });
        }

        // Handle synchronous functions
        const end = global.performance.now();
        updateStat(label, end - start);
        return result;
    }) as T;
};
