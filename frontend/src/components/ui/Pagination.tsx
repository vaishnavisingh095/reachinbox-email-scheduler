import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./Button";
import type { Pagination as PaginationType } from "@/types/api";

export function Pagination({
  pagination,
  page,
  onPageChange,
}: {
  pagination: PaginationType;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const { limit, total } = pagination;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
      <span>
        Page {page + 1} of {totalPages} · {total} total
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        <Button variant="secondary" size="sm" disabled={page + 1 >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
