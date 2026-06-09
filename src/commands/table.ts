import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { getTableUrl } from '../url.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

export function registerTableCommand(program: Command): void {
  program
    .command('table')
    .description('Display the league table')
    .option('--home', 'Show home table only')
    .option('--away', 'Show away table only')
    .action(async (opts) => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading table...');
        let option: 'home' | 'away' | undefined;
        if (opts.home) {
          option = 'home';
        } else if (opts.away) {
          option = 'away';
        }
        await page.goto(getTableUrl(community, option));
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const content = $('#kicktipp-content');

        let label = 'League Table';
        if (option === 'home') {
          label = 'League Table (Home)';
        } else if (option === 'away') {
          label = 'League Table (Away)';
        }
        console.log(label);
        console.log();

        const table = content.find('table').first();
        if (!table.length) {
          console.log('No table found.');
          return;
        }
        const tbody = table.find('tbody');
        if (!tbody.length) return;

        const teams: [string, string, string, string, string, string, string, string, string, string][] = [];
        tbody.children('tr').each((_, tr) => {
          const cols = $(tr).children('td');
          if (cols.length < 10) return;
          teams.push([
            $(cols[0]).text().trim(),
            $(cols[1]).text().trim(),
            $(cols[2]).text().trim(),
            $(cols[3]).text().trim(),
            $(cols[4]).text().trim(),
            $(cols[5]).text().trim(),
            $(cols[6]).text().trim(),
            $(cols[7]).text().trim(),
            $(cols[8]).text().trim(),
            $(cols[9]).text().trim(),
          ]);
        });

        if (teams.length) {
          const tw = Math.max(...teams.map((t) => t[1].length));
          console.log(
            `  ${'Pos'.padEnd(5)} ${'Team'.padEnd(tw)} ${'P'.padStart(3)} ${'Pts'.padStart(4)} ${'GF'.padStart(3)} ${'GA'.padStart(3)} ${'GD'.padStart(4)} ${'W'.padStart(3)} ${'D'.padStart(3)} ${'L'.padStart(3)}`,
          );
          console.log(`  ${'-'.repeat(tw + 33)}`);
          for (const [pos, team, played, pts, gf, ga, gd, w, d, l] of teams) {
            console.log(
              `  ${pos.padEnd(5)} ${team.padEnd(tw)} ${played.padStart(3)} ${pts.padStart(4)} ${gf.padStart(3)} ${ga.padStart(3)} ${gd.padStart(4)} ${w.padStart(3)} ${d.padStart(3)} ${l.padStart(3)}`,
            );
          }
        }
      } finally {
        await browser.close();
      }
    });
}
