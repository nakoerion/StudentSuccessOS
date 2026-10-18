"use client";

import { Slot } from "@radix-ui/react-slot";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "../lib/cn";

const listClass = "inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground";
const triggerClass =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all hover:text-foreground disabled:pointer-events-none disabled:opacity-50";
const activeClass = "bg-surface text-foreground shadow-xs";

/** Client-state tabs (Radix). */
export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn(listClass, className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(triggerClass, "data-[state=active]:bg-surface data-[state=active]:text-foreground data-[state=active]:shadow-xs", className)}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("mt-3", className)} {...props} />;
}

/**
 * URL-driven tabs with the same look: each trigger is a link (pass a Next
 * <Link> as the child), so filtering stays server-side and shareable.
 */
export function TabsNav({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <nav className={cn(listClass, className)} {...props} />;
}

export function TabsNavItem({
  active,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { active?: boolean }) {
  return (
    <Slot
      aria-current={active ? "page" : undefined}
      data-state={active ? "active" : "inactive"}
      className={cn(triggerClass, active && activeClass, className)}
      {...props}
    />
  );
}
