import readline from 'readline';
import { Page } from './browser.js';
import { loadCommunity, saveCommunity } from './config.js';
import { getCommunities } from './browser.js';

export const ask = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
};

export async function ensureCommunity(page: Page): Promise<string> {
  let community = loadCommunity();
  if (!community) {
    const all = await getCommunities(page);
    if (!all.length) { console.error('No communities found.'); process.exit(1); }
    console.log('Available communities:');
    all.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
    const choice = await ask(`Select community (1-${all.length}): `);
    const idx = parseInt(choice) - 1;
    if (isNaN(idx) || idx < 0 || idx >= all.length) { console.error('Invalid selection.'); process.exit(1); }
    saveCommunity(all[idx]);
    console.log(`Saved '${all[idx]}' as default community.`);
    community = all[idx];
  }
  return community;
}
