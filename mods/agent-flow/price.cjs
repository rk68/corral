// API list prices per million tokens [input, output, cache read], first match wins. Cache
// writes cost 1.25x input (5 min) or 2x (1 h), fast mode 2x. This is what the tokens would
// cost on the API, not what a Claude plan bills.
const PRICES = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.2], [/fable-5|mythos-5/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2], [/opus/, 5, 25, 0.5],
  [/sonnet-5-5/, 2, 10, 0.1], [/sonnet-5/, 2, 10, 0.2], [/sonnet/, 3, 15, 0.3],
  [/haiku-5-5/, 0.1, 0.5, 0.01], [/haiku/, 1, 5, 0.1],
];
const rates = (model) => PRICES.find(([re]) => re.test(model ?? ""))?.slice(1) ?? null;
function price(model, u) {
  const p = rates(model);
  if (!p) return 0;
  const [i, o, r] = p;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  const usd = ((u.input_tokens ?? 0) * i + (u.output_tokens ?? 0) * o + (u.cache_read_input_tokens ?? 0) * r + w5m * i * 1.25 + w1h * i * 2) / 1e6;
  return u.speed === "fast" ? usd * 2 : usd;
}

module.exports = { price, rates };
