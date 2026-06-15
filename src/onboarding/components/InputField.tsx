type InputFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string | null;
  type?: 'text' | 'email';
};

export function InputField({
  label,
  value,
  onChange,
  placeholder,
  required,
  error,
  type = 'text',
}: InputFieldProps) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required ? <span className="field-req"> *</span> : null}
      </span>
      <input
        className={error ? 'field-input field-input-error' : 'field-input'}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}
