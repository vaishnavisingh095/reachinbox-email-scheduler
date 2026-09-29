import { forwardRef, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, className = "", ...props }, ref) => {
    const inputId = id ?? props.name;
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`rounded-lg border px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 ${
            error ? "border-red-300 focus:border-red-400" : "border-gray-300 focus:border-indigo-400"
          } ${className}`}
          {...props}
        />
        {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs text-gray-500">{hint}</p> : null}
      </div>
    );
  }
);
Input.displayName = "Input";
