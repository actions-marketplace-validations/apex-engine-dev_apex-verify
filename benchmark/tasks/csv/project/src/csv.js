export function parseCSV(text) {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
}
