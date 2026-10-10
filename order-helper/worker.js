// ScrollStop order helper (Cloudflare Worker).
// After a customer pays on scrollstop.world, the site sends the PayPal order ID here.
// It also receives Contact us messages from the site and sends them to your phone (ntfy).
// This checks the payment with PayPal, then creates the matching order in CJ Dropshipping
// with the customer's address. The CJ order is created UNPAID: you tap Pay in CJ > My Orders.
//
// Secrets to add in Cloudflare (Settings > Variables and Secrets):
//   PAYPAL_CLIENT_ID, PAYPAL_SECRET  - from developer.paypal.com > Apps & Credentials (Live)
//   CJ_API_KEY                       - from CJ > Authorization > API
//   NTFY_TOPIC (optional)            - a ntfy.sh topic name for phone alerts on each order
//   DEFAULT_PHONE (optional)         - phone number CJ uses when PayPal doesn't share the buyer's

const SITE = "https://scrollstop.world";

// Store product id -> CJ variant id and the price customers pay. The live list is read from
// scrollstop.world/products.json (updated with the site), so new products work without
// re-pasting this code. This built-in copy is only a fallback if that file can't be read.
const FALLBACK_PRODUCTS = {
  "magsafe-powerbank": { vid: "1888050832044244994", price: 34.99 },
  "fleece-tights": { vid: "1575007430411563009", price: 19.99 },
  "fuzzy-socks": { vid: "1668434970286759936", price: 16.99 },
  "lip-oil": { vid: "2407200328221607300", price: 14.99 },
  "magnetic-lashes": { vid: "1790267011067551744", price: 16.99 },
  "whitening-pen": { vid: "1831957406138912768", price: 19.99 },
  "coconut-perfume": { vid: "1851189076431884288", price: 19.99 },
  "face-neck-massager": { vid: "1914883004026212353", price: 44.99 },
  "rose-necklace-box": { vid: "1699615145128894464", price: 34.99 },
  "clover-heart-necklace": { vid: "1727170587803521024", price: 14.99 },
  "car-charger-100w": { vid: "1692707565798428672", price: 34.99 },
  "magnetic-led-cable": { vid: "3CDD8C8B-FDA6-4C25-AEDF-4D6548709BFA", price: 16.99 },
  "wireless-charger-stand": { vid: "1736657502315491328", price: 29.99 },
  "garment-steamer": { vid: "1744354266527051776", price: 29.99 },
  "oil-sprayer": { vid: "43151312-68D1-439E-ADE5-1580180791DD", price: 16.99 },
  "lint-roller": { vid: "1653949161345134592", price: 19.99 },
  "projection-humidifier": { vid: "CC596E3B-7503-4B74-81D5-C467A1C9EE2D", price: 27.99 },
  "bunny-night-light": { vid: "1770035341332844544", price: 27.99 },
  "pet-hair-glove": { vid: "2603070947481606400", price: 12.99 },
  "jumping-fish-toy": { vid: "AC9E74D4-CA38-4C68-AF9E-7E725B0C5838", price: 19.99 }
};

const CJ = "https://developers.cjdropshipping.com/api2.0/v1/";
const cors = { "Access-Control-Allow-Origin": SITE, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notify(env, title, message) {
  if (!env.NTFY_TOPIC) return;
  try { await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers: { Title: title }, body: message }); } catch (e) {}
}

// Contact us form -> phone alert with the shopper's message and a Reply by email button.
async function handleContact(env, d) {
  const clip = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  if (d.website) return json({ ok: true, contact: true }); // hidden field only bots fill in
  const email = clip(d.email, 120), message = String(d.message || "").trim().slice(0, 2000);
  if (!/^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/.test(email) || !message) return json({ ok: false, contact: true, error: "email and message are required" }, 400);
  if (!env.NTFY_TOPIC) return json({ ok: false, contact: true, error: "alerts not set up" }, 500);
  const order = clip(d.order, 40), topic = clip(d.topic, 60) || "Message";
  const body = `${message}\n\nFrom: ${clip(d.name, 80) || "(no name)"} <${email}>${order ? `\nOrder: ${order}` : ""}`;
  const subject = encodeURIComponent(`Re: ${topic}${order ? ` (order ${order})` : ""}`);
  const r = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", body: `${topic}\n${body}`,
    headers: { Title: "New ScrollStop customer message", Tags: "email", Actions: `view, Reply by email, mailto:${email}?subject=${subject}` } });
  return r.ok ? json({ ok: true, contact: true }) : json({ ok: false, contact: true, error: "alert failed" }, 502);
}

async function paypalOrder(env, id) {
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
  const t = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials"
  }).then((r) => r.json());
  if (!t.access_token) throw new Error("PayPal login failed: check PAYPAL_CLIENT_ID and PAYPAL_SECRET");
  const r = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (!r.ok) throw new Error(`PayPal order ${id} not found`);
  return r.json();
}

async function cj(path, token, body) {
  await sleep(1100); // CJ allows 1 request per second
  const r = await fetch(CJ + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "CJ-Access-Token": token } : {}) }, body: JSON.stringify(body)
  }).then((r) => r.json());
  if (r.code !== 200 || r.result === false) throw new Error(`CJ ${path}: ${r.message || JSON.stringify(r).slice(0, 300)}`);
  return r.data;
}

async function loadProducts() {
  try {
    const r = await fetch(`${SITE}/products.json`, { cf: { cacheTtl: 300 } });
    if (r.ok) { const p = await r.json(); if (p && Object.keys(p).length) return p; }
  } catch (e) {}
  return FALLBACK_PRODUCTS;
}

async function handleOrder(env, orderId) {
  const PRODUCTS = await loadProducts();
  const order = await paypalOrder(env, orderId);
  if (order.status !== "COMPLETED") throw new Error(`PayPal order ${orderId} is ${order.status}, not paid`);
  const unit = order.purchase_units[0];
  const ship = unit.shipping || {};
  const a = ship.address || {};
  if (a.country_code !== "US") throw new Error(`Order ${orderId} ships to ${a.country_code}; CJ US warehouse only ships in the US`);

  const items = (unit.items || []).map((i) => ({ id: i.sku, qty: parseInt(i.quantity, 10) }));
  if (!items.length || items.some((i) => !PRODUCTS[i.id] || !(i.qty > 0))) throw new Error(`Order ${orderId} has an unknown product`);
  const expected = items.reduce((s, i) => s + PRODUCTS[i.id].price * i.qty, 0);
  const paid = parseFloat((unit.payments && unit.payments.captures || []).reduce((s, c) => s + parseFloat(c.amount.value), 0));
  if (paid + 0.01 < expected) throw new Error(`Order ${orderId} paid $${paid} but items cost $${expected.toFixed(2)}`);

  const token = (await cj("authentication/getAccessToken", null, { apiKey: env.CJ_API_KEY })).accessToken;
  // Some items sit in different US warehouses and can't share a parcel, so group the cart
  // into parcels CJ can ship together and make one CJ order per parcel.
  const quote = async (prods) => (await cj("logistic/freightCalculate", token, { startCountryCode: "US", endCountryCode: "US", products: prods })) || [];
  const groups = [];
  for (const i of items) {
    const line = { vid: PRODUCTS[i.id].vid, quantity: i.qty };
    let placed = false;
    for (const g of groups) {
      const q = await quote([...g.products, line]);
      if (q.length) { g.products.push(line); g.options = q; placed = true; break; }
    }
    if (!placed) {
      const q = await quote([line]);
      if (!q.length) throw new Error(`CJ has no US shipping option for ${i.id} in order ${orderId}`);
      groups.push({ products: [line], options: q });
    }
  }

  // CJ requires a 6-32 digit phone. PayPal often doesn't share the buyer's, so fall back to
  // DEFAULT_PHONE (your own number, optional secret) or a placeholder.
  const rawPhone = ship.phone_number?.national_number || order.payer?.phone?.phone_number?.national_number || "";
  const phone = /^\d{6,32}$/.test(rawPhone.replace(/\D/g, "")) ? rawPhone.replace(/\D/g, "") : (env.DEFAULT_PHONE || "0000000000");

  const created = [];
  for (const [n, g] of groups.entries()) {
    const cheapest = g.options.reduce((m, o) => (o.logisticPrice < m.logisticPrice ? o : m));
    created.push(await cj("shopping/order/createOrderV2", token, {
      orderNumber: groups.length > 1 ? `${orderId}-${n + 1}` : orderId,
      shippingCountryCode: "US",
      shippingCountry: "United States",
      shippingProvince: a.admin_area_1 || "",
      shippingCity: a.admin_area_2 || "",
      shippingZip: a.postal_code || "",
      shippingCustomerName: (ship.name && ship.name.full_name) || [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" "),
      shippingAddress: a.address_line_1 || "",
      shippingAddress2: a.address_line_2 || "",
      shippingPhone: phone,
      email: order.payer?.email_address || "",
      logisticName: cheapest.logisticName,
      fromCountryCode: "US",
      payType: 3, // create only; you pay it in CJ
      remark: "ScrollStop website order",
      products: g.products
    }));
  }
  return { cjOrders: created.length, items };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("ScrollStop order helper is running.", { headers: cors });
    let orderId = "";
    try {
      const data = await request.json();
      if (data.type === "contact") return await handleContact(env, data);
      orderId = String(data.orderID || "").slice(0, 40);
      if (!/^[A-Z0-9]+$/.test(orderId)) return json({ ok: false, error: "missing order ID" }, 400);
      const r = await handleOrder(env, orderId);
      await notify(env, "New order sent to CJ", `PayPal ${orderId}: ${r.items.map((i) => `${i.qty}x ${i.id}`).join(", ")}. ${r.cjOrders > 1 ? `Split into ${r.cjOrders} CJ orders. ` : ""}Open CJ > My Orders and tap Pay.`);
      return json({ ok: true });
    } catch (e) {
      await notify(env, "Order NOT sent to CJ", `PayPal ${orderId}: ${e.message}. Place this one by hand from the PayPal email.`);
      return json({ ok: false, error: e.message }, 500);
    }
  }
};
