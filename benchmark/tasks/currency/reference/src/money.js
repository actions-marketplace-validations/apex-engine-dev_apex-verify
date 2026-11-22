export const toCents = (dollars) => Math.round(dollars * 100);
const SYMBOL = { USD: "$", EUR: "€", GBP: "£" };
export function formatMoney(cents, currency) {
  const sym = SYMBOL[currency];
  if (!sym) throw new Error("unsupported currency " + currency);
  if (!Number.isInteger(cents)) throw new Error("cents must be an integer");
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (cents < 0 ? "-" : "") + sym + whole + "." + String(abs % 100).padStart(2, "0");
}
