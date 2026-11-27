// Usage: node publish-content.cjs path/to/backup.json
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const input = process.argv[2];
if (!input) throw new Error('Provide the JSON backup exported by the birthday site.');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'model.js'), 'utf8'), context);
const data = context.window.GiftModel.migrate(JSON.parse(fs.readFileSync(input, 'utf8')), 'published-gift');
context.window.GiftModel.validate(data);
data.unlocked = [];
fs.writeFileSync(path.join(__dirname, 'published-data.js'), 'window.PUBLISHED_GIFT = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';\n');
console.log(`Published snapshot: ${data.stories.length} stories, ${data.photos.length} photos. Push published-data.js to deploy.`);
