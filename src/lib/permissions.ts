export type Permission =
  | "inventory.view" | "inventory.count" | "inventory.review" | "inventory.post" | "inventory.adjust"
  | "inventory.settings" | "inventory.transfer" | "waste.log"
  | "products.edit" | "products.local_edit" | "vendors.edit"
  | "orders.view" | "orders.create" | "orders.submit" | "orders.receive" | "orders.reconcile" | "orders.reconcile_override"
  | "recipes.view" | "recipes.edit" | "production.log" | "sales.import" | "forecast.edit"
  | "reports.view" | "reports.view_cost" | "reports.view_corporate"
  | "tasks.manage" | "users.manage" | "locations.manage" | "settings.manage" | "audit.view";

export const ROLE_OPTIONS = [
  { key: "system_owner", name: "System Owner" },
  { key: "corporate_admin", name: "Corporate Admin" },
  { key: "regional_manager", name: "Regional Manager" },
  { key: "district_manager", name: "District Manager" },
  { key: "general_manager", name: "General Manager" },
  { key: "kitchen_manager", name: "Kitchen Manager" },
  { key: "bar_manager", name: "Bar Manager" },
  { key: "inventory_manager", name: "Inventory Manager" },
  { key: "accounting", name: "Accounting" },
  { key: "employee", name: "Employee" },
  { key: "read_only", name: "Read Only" },
] as const;
