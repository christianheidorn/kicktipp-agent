export const AUTH_VALUE_FORMAT = '<community>,<player>,<email>,<password>';
export const AUTH_VALUE_EXAMPLE = 'bundesliga-tipps,player-name,player@example.com,example-password';

export const AUTH_CONNECTION_DESCRIPTION = [
  'Hosted HTTP MCP clients authenticate with a single bearer auth value.',
  'Paste the auth value into your MCP client connection settings, or send it as the Authorization bearer token.',
  `Auth value format: ${AUTH_VALUE_FORMAT}`,
  `Example: ${AUTH_VALUE_EXAMPLE}`,
].join('\n');

export const AUTH_HEADER_HINT = [
  `Authorization: Bearer ${AUTH_VALUE_FORMAT}`,
  '(player may be empty)',
].join(' ');
