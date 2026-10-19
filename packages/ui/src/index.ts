/**
 * @ssos/ui — design tokens + shadcn/ui-style primitives.
 *
 * Tokens: `@import "@ssos/ui/styles.css";` in the app stylesheet (Tailwind v4).
 * Components use logical properties only (ps/pe/ms/me, start/end) — RTL-safe.
 */
export { cn } from "./lib/cn";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Input, Label } from "./components/input";
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./components/card";
export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./components/table";
export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export { Tabs, TabsList, TabsTrigger, TabsContent, TabsNav, TabsNavItem } from "./components/tabs";
export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem } from "./components/select";
