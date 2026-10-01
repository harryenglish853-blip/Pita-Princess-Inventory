import type { Permission } from "@/lib/permissions";

export type NavItem = { href: string; label: string; icon: string; perm?: Permission; section: string; feature?: "ordering" };

// Desktop sidebar order follows the restaurant's day: stock, deliveries, ordering, loss, cost.
export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "home", section: "Operations" },
  { href: "/inventory", label: "Inventory", icon: "boxes", perm: "inventory.view", section: "Operations" },
  { href: "/counts", label: "Counts", icon: "clipboard", perm: "inventory.count", section: "Operations" },
  { href: "/receiving", label: "Receiving", icon: "truck", perm: "orders.receive", section: "Operations" },
  { href: "/ordering", label: "Ordering", icon: "cart", perm: "orders.create", section: "Operations" },
  { href: "/purchasing", label: "Purchase orders", icon: "receipt", perm: "orders.view", section: "Operations", feature: "ordering" },
  { href: "/vendors", label: "Vendors", icon: "store", perm: "orders.create", section: "Operations" },
  { href: "/commissary", label: "Commissary", icon: "chef", perm: "orders.view", section: "Operations" },
  { href: "/waste", label: "Waste", icon: "trash", perm: "waste.log", section: "Operations" },
  { href: "/transfers", label: "Transfers", icon: "shuffle", perm: "inventory.transfer", section: "Operations" },
  { href: "/recipes", label: "Recipes & Menu", icon: "chef", perm: "recipes.view", section: "Kitchen" },
  { href: "/production", label: "Prep / Production", icon: "flame", perm: "production.log", section: "Kitchen" },
  { href: "/sales", label: "Sales / Toast", icon: "receipt", perm: "sales.import", section: "Kitchen" },
  { href: "/food-cost", label: "Food Cost", icon: "percent", perm: "reports.view_cost", section: "Analysis" },
  { href: "/reports", label: "Reports", icon: "chart", perm: "reports.view", section: "Analysis" },
  { href: "/tasks", label: "Tasks & Alerts", icon: "bell", section: "Analysis" },
  { href: "/inventory/storage", label: "Storage & Shelf Order", icon: "layers", perm: "inventory.settings", section: "Admin" },
  { href: "/setup", label: "Getting started", icon: "clipboard", perm: "inventory.settings", section: "Admin" },
  { href: "/admin", label: "Administration", icon: "settings", section: "Admin" },
];
