import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  /** 非阻断的警告提示（黄色样式，不标记 aria-invalid）；可与 error 同时存在。 */
  warning?: string;
  /** 警告提示容器的 data-testid（便于 UI 测试定位）。 */
  warningTestId?: string;
  rightElement?: ReactNode;
}

export function Input({
  label,
  hint,
  error,
  warning,
  warningTestId,
  rightElement,
  className = '',
  id,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const warningId = warning ? `${inputId}-warning` : undefined;
  const describedBy =
    [rest['aria-describedby'], errorId, warningId, hintId].filter(Boolean).join(' ') || undefined;
  const inputClassName = [
    'input',
    rightElement ? 'input-with-right-element' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="form-group">
      {label && <label htmlFor={inputId}>{label}</label>}
      <div className="input-wrapper">
        <input
          id={inputId}
          className={inputClassName}
          aria-invalid={Boolean(error) || rest['aria-invalid']}
          aria-describedby={describedBy}
          {...rest}
        />
        {rightElement && <div className="input-right-element">{rightElement}</div>}
      </div>
      {hint && (
        <div id={hintId} className="hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errorId} className="error-box">
          {error}
        </div>
      )}
      {warning && (
        <div id={warningId} className="warning-box" role="status" data-testid={warningTestId}>
          {warning}
        </div>
      )}
    </div>
  );
}
