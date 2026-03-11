/**
 * SkeletonScreen — re-exports skeleton variants from ui/Skeleton.
 *
 * The ListSkeleton wrapper bridges the legacy `rows` prop to the new
 * `count` prop used by the ui/Skeleton component.
 */

export { CardSkeleton, MacroBarSkeleton, TableSkeleton } from './ui/Skeleton';

import { ListSkeleton as BaseListSkeleton } from './ui/Skeleton';
import type { HTMLAttributes } from 'react';

interface ListSkeletonLegacyProps extends HTMLAttributes<HTMLDivElement> {
  rows?: number;
}

/**
 * ListSkeleton with backward-compatible `rows` prop.
 * Maps `rows` to `count` used by ui/Skeleton.
 */
export function ListSkeleton({ rows, ...rest }: ListSkeletonLegacyProps) {
  return <BaseListSkeleton count={rows} {...rest} />;
}
