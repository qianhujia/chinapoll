#!/usr/bin/env node

const args = process.argv.slice(2);

function showHelp() {
  console.log('ChinaPoll admin CLI');
  console.log('Usage:');
  console.log('  npx admin-cli audit-proposal <id>');
  console.log('  npx admin-cli publish-issue <id>');
  console.log('  npx admin-cli finalize <issueId>');
  console.log('  npx admin-cli readonly on|off');
}

const command = args[0] ?? 'help';

switch (command) {
  case 'audit-proposal':
    console.log(`Audit proposal ${args[1] ?? 'unknown'} with rule set: 1, 2, 3, 4, 5`);
    break;
  case 'publish-issue':
    console.log(`Publish issue ${args[1] ?? 'unknown'} to the public feed.`);
    break;
  case 'finalize':
    console.log(`Finalize issue ${args[1] ?? 'unknown'} and export CSV snapshot.`);
    break;
  case 'readonly':
    console.log(`Readonly flag set to ${args[1] ?? 'off'}`);
    break;
  case 'help':
  default:
    showHelp();
    break;
}
