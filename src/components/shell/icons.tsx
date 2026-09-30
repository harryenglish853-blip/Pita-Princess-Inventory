import { Bell, Boxes, ChartColumn, ClipboardList, Home, Layers, Menu, Search, Settings, ShoppingCart, Store, Truck, Trash2, ChefHat } from "lucide-react";

const map = { home: Home, bell: Bell, boxes: Boxes, clipboard: ClipboardList, layers: Layers, cart: ShoppingCart, truck: Truck, store: Store, chart: ChartColumn, settings: Settings, menu: Menu, search: Search, trash: Trash2, chef: ChefHat };

export function Icon({ name, className }: { name: string; className?: string }) {
  const C = map[name as keyof typeof map] ?? Home;
  return <C className={className ?? "h-4 w-4"} aria-hidden />;
}
