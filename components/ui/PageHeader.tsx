import type { ReactNode } from "react";
export function PageHeader({title,description,action}:{title:string;description?:string;action?:ReactNode}) {
 return <div className="mb-5 flex flex-col items-start justify-between gap-4 border-b border-line pb-5 sm:mb-7 sm:flex-row sm:flex-wrap sm:items-center"><div><h1 className="text-h1 text-ink-900">{title}</h1>{description&&<p className="mt-1.5 max-w-2xl text-sm leading-6 text-ink-500">{description}</p>}</div>{action&&<div className="w-full sm:w-auto sm:shrink-0">{action}</div>}</div>;
}
