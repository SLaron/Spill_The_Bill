// ---------- State (single source of truth) ----------
const state = {
  bill: {
    items: [
      { id: 1, name: "Paneer Tikka", price: 280, qty: 1 },
      { id: 2, name: "Butter Naan", price: 60, qty: 4 },
      { id: 3, name: "Cold Coffee", price: 150, qty: 2 },
    ],
    tax: 62.5,
  },
  people: [
    { id: 1, name: "Aman" },
    { id: 2, name: "Riya" },
  ],
  // itemId -> list of personIds who had it
  selections: { 1: [1, 2], 2: [1], 3: [2] },
  taxMode: "proportional", // or "equal"
  nextItemId: 4,
  nextPersonId: 3,
};

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const money = (paise) => "₹" + (paise / 100).toFixed(2);
//UNDERSTAND THIS LATER
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lineTotalPaise = (it) => Math.round(it.price * it.qty * 100);

// ---------- Calculation (all money in paise) ----------
function sharersOf(item) {
  const valid = new Set(state.people.map((p) => p.id));
  return (state.selections[item.id] || []).filter((id) => valid.has(id));
}

function calculate() {
  const { bill, people, taxMode } = state;
  const sub = {}; //sub = subtotall
  people.forEach((p) => (sub[p.id] = 0));

  bill.items.forEach((it) => {
    const ids = sharersOf(it);
    if (!ids.length) return;
    const share = lineTotalPaise(it) / ids.length;
    ids.forEach((id) => (sub[id] += share));
  });

  const taxP = Math.round(bill.tax * 100);
  const grand = Object.values(sub).reduce((a, b) => a + b, 0);

  const rows = people.map((p) => {
    let tax = 0;
    if (taxMode === "equal") tax = people.length ? taxP / people.length : 0;
    else if (grand > 0) tax = (sub[p.id] / grand) * taxP;
    return { name: p.name, subtotal: sub[p.id], total: sub[p.id] + tax };
  });
  return roundToTotal(rows);
}

// Rounds to whole paise so the individual totals add up exactly.
function roundToTotal(rows) {
  const target = Math.round(rows.reduce((a, r) => a + r.total, 0));
  const floors = rows.map((r) => Math.floor(r.total));
  let left = target - floors.reduce((a, b) => a + b, 0);
  rows
    .map((r, i) => ({ i, frac: r.total - floors[i] }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (left > 0) { floors[i]++; left--; }
    });
  return rows.map((r, i) => {
    const subtotal = Math.round(r.subtotal);
    return { name: r.name, subtotal, tax: floors[i] - subtotal, total: floors[i] };
  });
}

function unassignedPaise() {
  return state.bill.items
    .filter((it) => sharersOf(it).length === 0)
    .reduce((a, it) => a + lineTotalPaise(it), 0);
}

// ---------- Rendering ----------
function renderItems() {
  const { items, tax } = state.bill;
  $("items").innerHTML = items.length
    ? items.map((it) => `
        <li>

  <span>${esc(it.name)} <small>${it.qty} × ${money(it.price * 100)}</small></span>

  <span class="item-total">${money(lineTotalPaise(it))}</span>

  <span class="qty">
    <button type="button" class="step" data-qty-item="${it.id}" data-delta="-1" aria-label="One less ${esc(it.name)}">−</button>
    <span>${it.qty}</span>
    <button type="button" class="step" data-qty-item="${it.id}" data-delta="1" aria-label="One more ${esc(it.name)}">+</button>
  </span>

  <button type="button" class="ghost" data-remove-item="${it.id}" aria-label="Remove ${esc(it.name)}">Remove</button>

</li>`).join("")
    : `<li class="empty">No items yet. Add the first one below.</li>`;

  const itemsTotal = items.reduce((a, it) => a + lineTotalPaise(it), 0);
  $("bill-total").textContent =
    `Items ${money(itemsTotal)} + tax ${money(Math.round(tax * 100))} = ${money(itemsTotal + Math.round(tax * 100))}`;
}

function renderPeople() {
  $("people").innerHTML = state.people.length
    ? state.people.map((p) => `
        <li>${esc(p.name)}
          <button type="button" class="ghost" data-remove-person="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
        </li>`).join("")
    : `<li class="empty">Add the people who ate.</li>`;
}

function renderAssign() {
  const { items } = state.bill;
  if (!items.length || !state.people.length) {
    $("assign").innerHTML = `<p class="empty">Add items and people to start assigning.</p>`;
    return;
  }
  $("assign").innerHTML = items.map((it) => {
    const chosen = sharersOf(it);
    const chips = state.people.map((p) => `
      <button type="button" class="chip ${chosen.includes(p.id) ? "on" : ""}"
        data-item="${it.id}" data-person="${p.id}" aria-pressed="${chosen.includes(p.id)}">${esc(p.name)}</button>`).join("");
    return `<div class="row"><div class="rowhead">${esc(it.name)} <small>${money(lineTotalPaise(it))}</small></div><div class="chips">${chips}</div></div>`;
  }).join("");
}

function renderResults() {
  const rows = calculate();
  const un = unassignedPaise();
  $("warning").textContent = un > 0 ? `${money(un)} of items aren't assigned to anyone yet.` : "";
  $("results").innerHTML = rows.length
    ? rows.map((r) => `
        <div class="card">
          <h3>${esc(r.name)}</h3>
          <p class="amount">${money(r.total)}</p>
          <p class="breakdown">Food ${money(r.subtotal)} + tax ${money(r.tax)}</p>
        </div>`).join("")
    : `<p class="empty">Totals appear here once you add people.</p>`;
}

function render() {
  renderItems();
  renderPeople();
  renderAssign();
  renderResults();
}

// ---------- Events ----------
$("item-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("item-name").value.trim();
  const price = parseFloat($("item-price").value);
  const qty = parseInt($("item-qty").value, 10);
  if (!name || !(price >= 0) || !(qty >= 1)) return;
  state.bill.items.push({ id: state.nextItemId++, name, price, qty });
  e.target.reset();
  $("item-qty").value = 1;
  $("item-name").focus();
  render();
});

$("person-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("person-name").value.trim();
  if (!name) return;
  state.people.push({ id: state.nextPersonId++, name });
  e.target.reset();
  $("person-name").focus();
  render();
});

$("tax").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  state.bill.tax = v >= 0 ? v : 0;
  renderItems();
  renderResults();
});

$("tax-mode").addEventListener("change", (e) => {
  state.taxMode = e.target.value;
  renderResults();
});

$("items").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  // + / - buttons change the quantity; going below 1 removes the item
  if (btn.dataset.qtyItem) {
    const item = state.bill.items.find((it) => it.id === +btn.dataset.qtyItem);
    if (!item) return;
    item.qty += +btn.dataset.delta;
    if (item.qty < 1) {
      state.bill.items = state.bill.items.filter((it) => it.id !== item.id);
      delete state.selections[item.id];
    }
    render();
    return;
  }

  const id = btn.dataset.removeItem;
  if (!id) return;
  state.bill.items = state.bill.items.filter((it) => it.id !== +id);
  delete state.selections[id];
  render();
});

$("people").addEventListener("click", (e) => {
  const id = e.target.dataset.removePerson;
  if (!id) return;
  state.people = state.people.filter((p) => p.id !== +id);
  Object.keys(state.selections).forEach((k) => {
    state.selections[k] = state.selections[k].filter((pid) => pid !== +id);
  });
  render();
});

$("assign").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  const itemId = +btn.dataset.item;
  const personId = +btn.dataset.person;
  const list = state.selections[itemId] || (state.selections[itemId] = []);
  const at = list.indexOf(personId);
  if (at === -1) list.push(personId);
  else list.splice(at, 1);
  renderAssign();
  renderResults();
});

// ---------- Start ----------
$("tax").value = state.bill.tax;
render();
