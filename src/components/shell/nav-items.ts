import type { Permission } from "@/lib/permissions";

export type NavItem = { href: string; label: string; icon: string; perm?: Permission; section: string };

export const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: "home", section: "Operations" },
  { href: "/tasks", label: "Tasks & Alerts", icon: "bell", section: "Operations" },
  { href: "/inventory", label: "Inventory", icon: "boxes", perm: "inventory.view", section: "Inventory" },
  { href: "/counts", label: "Physical Counts", icon: "clipboard", perm: "inventory.count", section: "Inventory" },
  { href: "/inventory/storage", label: "Storage & Shelf Order", icon: "layers", perm: "inventory.view", section: "Inventory" },
  { href: "/purchasing", label: "Purchasing", icon: "cart", perm: "orders.view", section: "Purchasing" },
  { href: "/receiving", label: "Receiving", icon: "truck", perm: "orders.receive", section: "Purchasing" },
  { href: "/vendors", label: "Vendors", icon: "store", perm: "orders.view", section: "Purchasing" },
  { href: "/reports", label: "Reports", icon: "chart", perm: "reports.view", section: "Analysis" },
  { href: "/admin", label: "Administration", icon: "settings", section: "Admin" },
];
