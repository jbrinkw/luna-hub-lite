/**
 * Generate a Walmart "Add to Cart" deep link from shopping list items.
 * Extracts product IDs from walmart_link URLs and builds a bulk-add URL.
 */
export function generateWalmartCartLink(
  items: Array<{
    products?: { walmart_link?: string | null; is_placeholder?: boolean } | null;
    qty_containers: number;
  }>,
): string | null {
  const cartItems: string[] = [];

  for (const item of items) {
    if (item.products?.is_placeholder) continue;

    const url = item.products?.walmart_link;
    if (!url) continue;

    // Extract numeric product ID from Walmart URL: .../ip/Product-Name/12345
    const match = url.match(/\/ip\/[^/]+\/(\d+)/);
    if (match?.[1]) {
      const qty = Math.ceil(item.qty_containers);
      if (qty > 0) {
        cartItems.push(`${match[1]}|${qty}`);
      }
    }
  }

  if (cartItems.length === 0) return null;

  return `https://affil.walmart.com/cart/addToCart?items=${cartItems.join(',')}`;
}
