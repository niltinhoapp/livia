import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function TableContainer({ className = "", children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`overflow-x-auto rounded-card border border-line bg-white shadow-e1 ${className}`} {...props}>
      {children}
    </div>
  );
}

export function Table({ className = "", children, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <table className={`w-full border-collapse text-left text-sm text-ink-700 ${className}`} {...props}>
      {children}
    </table>
  );
}

export function TableHeader({ className = "", children, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={`border-b border-line bg-ink-50/70 text-xs font-semibold uppercase tracking-wider text-ink-500 ${className}`} {...props}>
      {children}
    </thead>
  );
}

export function TableBody({ className = "", children, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={`divide-y divide-line ${className}`} {...props}>
      {children}
    </tbody>
  );
}

export function TableRow({ className = "", children, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={`transition-colors duration-150 hover:bg-ink-50/50 ${className}`} {...props}>
      {children}
    </tr>
  );
}

export function TableHead({ className = "", children, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={`px-4 py-3 font-semibold ${className}`} {...props}>
      {children}
    </th>
  );
}

export function TableCell({ className = "", children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`px-4 py-3.5 align-middle ${className}`} {...props}>
      {children}
    </td>
  );
}
