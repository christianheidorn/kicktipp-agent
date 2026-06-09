import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { getOverviewUrl } from '../url.js';
import { loadPlayer } from '../config.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

const OVERVIEW_VIEWS: Record<string, [string, string]> = {
  'matchday-points': ['spieltagspunkte', 'Matchday points'],
  'standings': ['platzierungen', 'Standings'],
  'standings-diff': ['platzierungsdifferenz', 'Standings difference'],
  'matchday-standings': ['spieltagsplatzierungen', 'Matchday standings'],
  'points-from-leader': ['punkteZurSpitze', 'Points from leader'],
};

export function registerOverviewCommand(program: Command): void {
  program
    .command('overview')
    .description('Display the season overview')
    .option('--view <value>', 'View type', 'matchday-points')
    .action(async (opts) => {
      const view = opts.view as string;
      if (!(view in OVERVIEW_VIEWS)) {
        console.error(`Unknown view '${view}'. Options: ${Object.keys(OVERVIEW_VIEWS).join(', ')}`);
        process.exit(1);
      }

      const [ansicht, label] = OVERVIEW_VIEWS[view];

      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading overview...');
        await page.goto(getOverviewUrl(community, ansicht));
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const content = $('#kicktipp-content');

        console.log(`Overview: ${label}`);
        console.log();

        const ranking = content.find('table#ranking');
        if (!ranking.length) {
          console.log('No data found.');
          return;
        }

        const tbody = ranking.find('tbody');
        if (!tbody.length) return;

        // Parse all rows
        const savedPlayer = loadPlayer();
        const players: {
          pos: string;
          name: string;
          matchdays: Record<number, string>;
          bonus: string;
          siege: string;
          total: string;
        }[] = [];
        let maxMatchday = 0;

        tbody.find('tr').each((_, tr) => {
          const posTd = $(tr).find('td.position');
          const nameDiv = $(tr).find('div.mg_name');
          if (!posTd.length || !nameDiv.length) return;

          const pos = posTd.text().trim();
          const name = nameDiv.text().trim();

          const matchdays: Record<number, string> = {};
          $(tr).find('td.spieltag').each((__, td) => {
            const classes = $(td).attr('class')?.split(/\s+/) || [];
            for (const cls of classes) {
              if (cls.startsWith('spieltag') && cls !== 'spieltag') {
                const idx = parseInt(cls.replace('spieltag', ''));
                const val = $(td).text().trim();
                if (val) {
                  matchdays[idx] = val;
                  if (idx > maxMatchday) maxMatchday = idx;
                }
              }
            }
          });

          const bonusTd = $(tr).find('td.bonus');
          const siegeTd = $(tr).find('td.siege');
          const punkteTd = $(tr).find('td.punkte');
          const bonus = bonusTd.length ? bonusTd.text().trim() : '';
          const siege = siegeTd.length ? siegeTd.text().trim() : '';
          const total = punkteTd.length ? punkteTd.text().trim() : '';

          players.push({ pos, name, matchdays, bonus, siege, total });
        });

        if (!players.length) {
          console.log('No data found.');
          return;
        }

        const nameWidth = Math.max(...players.map((p) => p.name.length));
        const mdRange = Array.from({ length: maxMatchday }, (_, i) => i + 1);

        // Header
        let header = `  ${'Pos'.padEnd(5)} ${'Name'.padEnd(nameWidth)}`;
        for (const md of mdRange) {
          header += ` ${String(md).padStart(3)}`;
        }
        header += `  ${'B'.padStart(3)} ${'W'.padStart(4)} ${'T'.padStart(5)}`;
        console.log(header);
        console.log(`  ${'-'.repeat(header.length - 2)}`);

        // Rows
        for (const { pos, name, matchdays, bonus, siege, total } of players) {
          const marker = savedPlayer && name === savedPlayer ? ' <' : '';
          let line = `  ${pos.padEnd(5)} ${name.padEnd(nameWidth)}`;
          for (const md of mdRange) {
            line += ` ${(matchdays[md] || '').padStart(3)}`;
          }
          line += `  ${bonus.padStart(3)} ${siege.padStart(4)} ${total.padStart(5)}${marker}`;
          console.log(line);
        }
      } finally {
        await browser.close();
      }
    });
}
