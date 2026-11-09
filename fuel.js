// ⛽ Gas cost: distance × your car's efficiency × the gas price. Pure ES module (no DOM) so it can be tested.
//
// effUnit: 'mpg' (US miles per gallon) · 'kml' (km per litre) · 'l100' (litres per 100 km)
// The price is per gallon with 'mpg', per litre otherwise.

const KM_PER_MILE = 1.609344, L_PER_GAL = 3.785411784;

/** Fuel used and its cost for a distance in metres. Returns null if the settings can't give an answer. */
export function fuelCost(metres, { eff, effUnit = 'mpg', price } = {}) {
  eff = +eff; price = +price;
  if (!(metres >= 0) || !(eff > 0) || !(price >= 0)) return null;
  const km = metres / 1000;
  let litres;
  if (effUnit === 'mpg') litres = (km / KM_PER_MILE / eff) * L_PER_GAL;
  else if (effUnit === 'l100') litres = km * eff / 100;
  else litres = km / eff; // km per litre
  const amount = effUnit === 'mpg' ? litres / L_PER_GAL : litres; // in the unit the price is quoted in
  return { litres, gallons: litres / L_PER_GAL, amount, unit: effUnit === 'mpg' ? 'gal' : 'L', cost: amount * price };
}

/** "$3.20" — two decimals, the symbol before the number (as typed in Settings). */
export const fmtMoney = (v, cur = '$') => `${cur || ''}${(Math.round(v * 100) / 100).toFixed(2)}`;
/** "about 3 dollars 20" for the voice (keeps it short; uses the symbol's word when known). */
export function sayMoney(v, cur = '$') {
  const words = { '$': ['dollar', 'dollars', 'cents'], '€': ['euro', 'euros', 'cents'], '£': ['pound', 'pounds', 'pence'], 'R$': ['real', 'reais', 'centavos'] }[cur];
  const whole = Math.floor(v + 1e-9), cents = Math.round((v - whole) * 100);
  if (!words) return `about ${(Math.round(v * 100) / 100).toFixed(2)}`;
  if (!whole) return `about ${cents} ${words[2]}`;
  return `about ${whole} ${whole === 1 ? words[0] : words[1]}${cents ? ` ${cents}` : ''}`;
}
