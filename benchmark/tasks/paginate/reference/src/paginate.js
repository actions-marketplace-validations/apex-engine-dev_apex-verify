export function paginate(items, page, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be a positive integer");
  const start = (page - 1) * size;
  return {
    items: items.slice(start, start + size),
    page,
    totalPages: Math.ceil(items.length / size),
  };
}
