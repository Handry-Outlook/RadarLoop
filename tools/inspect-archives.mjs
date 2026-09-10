/** Reports what date ranges the lightning archives actually cover. */

const URLS = [
  'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new/refs/heads/main/lightning_data.json',
  'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new/refs/heads/main/lightning_data_2025_autumn.json',
  'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new_2026/refs/heads/main/lightning_data_2026_summer_part1.json',
  'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new_2026/refs/heads/main/lightning_data_2026_summer.json',
];

const perDay = new Map();
let grandTotal = 0;

for (const url of URLS) {
  const name = url.split('/').pop();
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`${name.padEnd(42)} HTTP ${res.status}`); continue; }
    const json = await res.json();
    const strikes = json?.lightning_strikes ?? [];
    const times = strikes
      .map((s) => new Date(s.strike_time).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);

    grandTotal += times.length;
    for (const t of times) {
      const d = new Date(t).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) || 0) + 1);
    }

    console.log(`${name.padEnd(42)} ${String(times.length).padStart(8)} strikes  ` +
      (times.length
        ? `${new Date(times[0]).toISOString().slice(0, 16)} → ${new Date(times[times.length - 1]).toISOString().slice(0, 16)}`
        : '(empty)'));
  } catch (error) {
    console.log(`${name.padEnd(42)} ERROR ${error.message}`);
  }
}

console.log(`\ntotal archive strikes: ${grandTotal}`);

const days = [...perDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
console.log(`distinct days covered : ${days.length}`);
console.log('\nmost recent 20 days with data:');
for (const [day, count] of days.slice(0, 20)) {
  console.log(`  ${day}  ${String(count).padStart(7)}`);
}

const august = days.filter(([d]) => d.startsWith('2026-08'));
console.log(`\n2026-08 days with data: ${august.length}`);
august.slice(0, 12).forEach(([d, c]) => console.log(`  ${d}  ${String(c).padStart(7)}`));
