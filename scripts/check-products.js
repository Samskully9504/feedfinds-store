// Checks that the products shown on the site (index.html) match products.json, which the
// order helper reads to send orders to CJ. Run: node scripts/check-products.js
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "products.json"), "utf8"));
const block = html.match(/const PRODUCTS = (\[[\s\S]*?\n\]);/);
if (!block) { console.error("PRODUCTS list not found in index.html"); process.exit(1); }
const site = eval(block[1]);
const problems = [];
const ids = new Set();
for (const p of site) {
  if (ids.has(p.id)) problems.push(`${p.id}: listed twice on the site`);
  ids.add(p.id);
  const c = catalog[p.id];
  if (!c) problems.push(`${p.id}: missing from products.json`);
  else {
    if (c.price !== p.price) problems.push(`${p.id}: site price ${p.price} but products.json says ${c.price}`);
    if (!c.vid) problems.push(`${p.id}: no CJ variant id in products.json`);
  }
  if (p.img && !fs.existsSync(path.join(root, p.img))) problems.push(`${p.id}: image ${p.img} not found`);
}
for (const id of Object.keys(catalog)) if (!ids.has(id)) problems.push(`${id}: in products.json but not on the site`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`OK: ${site.length} products match products.json`);
