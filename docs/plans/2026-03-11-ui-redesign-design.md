# UI Redesign Design Document

**Date:** 2026-03-11
**Branch:** `pretty`
**Goal:** Replace the mixed Ionic/custom CSS UI with a unified Tailwind CSS design system. Clean, minimal, production-ready aesthetic. Same feature set, same layouts.

## Design Decisions

### Visual Language

- **Style:** Clean & minimal — whitespace, subtle borders, muted palette
- **Priority:** Easy to understand and pick up for any user
- **Desktop-first** (mobile pass deferred)

### Color System

| Token          | Value                 | Usage                       |
| -------------- | --------------------- | --------------------------- |
| bg             | slate-50 `#f8fafc`    | Page background             |
| surface        | white                 | Cards, panels               |
| border         | slate-200 `#e2e8f0`   | Card borders, dividers      |
| text           | slate-900 `#0f172a`   | Primary text                |
| text-secondary | slate-500 `#64748b`   | Labels, descriptions        |
| primary        | blue-600 `#2563eb`    | Actions, links              |
| success        | emerald-600 `#059669` | Positive states             |
| warning        | amber-500 `#f59e0b`   | Caution, low stock          |
| danger         | red-600 `#dc2626`     | Destructive actions, errors |

Module header accents: Hub=blue-600, CoachByte=violet-600, ChefByte=emerald-600

### Typography

- Font: Inter everywhere (replace Arial in CoachByte)
- Scale: Tailwind defaults (xs/sm/base/lg/xl/2xl)
- Weights: 400 body, 500 labels, 600 headings, 700 page titles

### Technical Approach

- **Drop Ionic React** entirely — replace with plain HTML + Tailwind
- **Add Tailwind CSS v4** via Vite plugin
- **Build thin component library** — Button, Card, Input, Select, Toggle, Modal, Table, Badge, Tabs, Sidebar, Skeleton, ProgressBar, Alert
- **Preserve all data-testid attributes** for test compatibility
- **Preserve all functionality** — only visual changes

### What Stays the Same

- All business logic, data flows, Supabase queries
- Page routing structure
- Context providers (AuthProvider, AppProvider)
- React Query setup
- All `data-testid` attributes

## Before Screenshots

Saved to `docs/screenshots/before-redesign/` (20 pages captured).
