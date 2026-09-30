import type { Permission } from "@/lib/permissions";

export type NavItem = { href: string; label: string; icon: string; perm?: Permission; section: string; feature?: "ordering" };

export const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: "home", section: "Operations" },
  { href: "/tasks", label: "Tasks & Alerts", icon: "bell", section: "Operations" },
  { href: "/inventory", label: "Inventory", icon: "boxes", perm: "inventory.view", section: "Inventory" },
  { href: "/counts", label: "Physical Counts", icon: "clipboard", perm: "inventory.count", section: "Inventory" },
  { href: "/waste", label: "Waste", icon: "trash", perm: "waste.log", section: "Inventory" },
  { href: "/transfers", label: "Transfers", icon: "shuffle", perm: "inventory.view", section: "Inventory" },
  { href: "/inventory/storage", label: "Storage & Shelf Order", icon: "layers", perm: "inventory.view", section: "Inventory" },
  { href: "/purchasing", label: "Purchasing", icon: "cart", perm: "orders.view", section: "Purchasing", feature: "ordering" },
  { href: "/receiving", label: "Receiving", icon: "truck", perm: "orders.receive", section: "Purchasing" },
  { href: "/vendors", label: "Vendors", icon: "store", perm: "orders.view", section: "Purchasing" },
  { href: "/recipes", label: "Recipes & Menu", icon: "chef", perm: "recipes.view", section: "Kitchen" },
  { href: "/production", label: "Prep / Production", icon: "flame", perm: "production.log", section: "Kitchen" },
  { href: "/sales", label: "Sales / POS", icon: "receipt", perm: "sales.import", section: "Kitchen" },
  { href: "/food-cost", label: "Food Cost (AvT)", icon: "percent", perm: "reports.view_cost", section: "Analysis" },
  { href: "/reports", label: "Reports", icon: "chart", perm: "reports.view", section: "Analysis" },
  { href: "/admin", label: "Administration", icon: "settings", section: "Admin" },
];
