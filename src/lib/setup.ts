/** Getting-started steps, derived from setup_status(). Shared by the checklist page and the home banner. */
export type SetupStatus = {
  address: boolean; storage_areas: number; vendors: number; products: number; products_placed: number; staff: number;
  counts_posted: number; deliveries: number; recipes: number; menu_items: number; sales_days: number;
};
export type SetupStep = { key: string; title: string; why: string; done: boolean; detail: string; href: string; action: string; later?: boolean };

export function setupSteps(s: SetupStatus): SetupStep[] {
  return [
    { key: "store", title: "Check your restaurant details", why: "Name, address, time zone and count tolerances.", done: s.address,
      detail: s.address ? "Address saved" : "No address yet", href: "/admin/locations", action: "Open locations" },
    { key: "storage", title: "Add your storage areas", why: "Walk-in, freezer, dry storage… in the order you walk them.", done: s.storage_areas > 0,
      detail: `${s.storage_areas} area${s.storage_areas === 1 ? "" : "s"}`, href: "/inventory/storage", action: "Storage areas" },
    { key: "products", title: "Add your products", why: "Upload a spreadsheet (vendors, categories and storage areas are created for you) or add them one by one.", done: s.products > 0,
      detail: `${s.products} product${s.products === 1 ? "" : "s"}`, href: "/inventory/import", action: "Import spreadsheet" },
    { key: "vendors", title: "Check your vendors", why: "Delivery days, account numbers, item codes and case prices.", done: s.vendors > 0,
      detail: `${s.vendors} vendor${s.vendors === 1 ? "" : "s"}`, href: "/vendors", action: "Vendors" },
    { key: "shelf", title: "Put items in shelf order", why: "Count sheets follow this order, shelf by shelf.", done: s.products > 0 && s.products_placed >= s.products,
      detail: `${s.products_placed} of ${s.products} placed`, href: "/inventory/storage", action: "Shelf order" },
    { key: "staff", title: "Add your team", why: "Managers, and the people who count and receive. Each gets their own login.", done: s.staff > 1,
      detail: `${s.staff} ${s.staff === 1 ? "person" : "people"}`, href: "/admin/users", action: "Users" },
    { key: "count", title: "Do your first full count", why: "It sets your starting inventory. Everything after builds on it.", done: s.counts_posted > 0,
      detail: s.counts_posted ? `${s.counts_posted} posted` : "Not yet", href: "/counts", action: "Counts" },
    { key: "delivery", title: "Log your first delivery", why: "Receiving → Log a delivery, from the invoice.", done: s.deliveries > 0,
      detail: s.deliveries ? `${s.deliveries} posted` : "Not yet", href: "/receiving", action: "Receiving" },
    { key: "recipes", title: "Add recipes and menu items", why: "Needed for food cost: what each sale should use.", done: s.recipes > 0 && s.menu_items > 0, later: true,
      detail: `${s.recipes} recipes · ${s.menu_items} linked to the POS`, href: "/recipes", action: "Recipes" },
    { key: "sales", title: "Import daily sales from your POS", why: "With recipes, this gives theoretical usage and actual vs theoretical food cost.", done: s.sales_days > 0, later: true,
      detail: s.sales_days ? `${s.sales_days} days imported` : "Not yet", href: "/sales", action: "Sales import" },
  ];
}
