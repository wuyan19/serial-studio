import { useRef } from "react";
import type { ConnectionColors } from "../connection-colors";
import { IconShirt } from "../icons";
import { overlayClose, useDialogA11y, useEscClose } from "./primitives";

export function ConnectionColorsDialog({ label, colors, defaults, error, onChange, onSave, onCancel }: {
  label: string;
  colors: ConnectionColors;
  defaults: Required<ConnectionColors>;
  error: string;
  onChange: (colors: ConnectionColors) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogA11y(dialog);
  useEscClose(onCancel);

  return <div className="dialog-overlay" onMouseDown={(event) => overlayClose(event, onCancel)}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="连接配色" className="dialog dialog--narrow">
      <h3 className="dialog__title"><IconShirt /> 连接配色</h3>
      <div className="dialog__sub">{label}</div>
      <p className="dialog__hint">配色保存到本地，并应用于此连接的所有标签页。</p>
      <form onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        {([["tab", "选中标签下划线"], ["cursor", "终端游标"]] as const).map(([key, label]) => (
          <div className="connection-color-row" key={key}>
            <label>
              <span>{label}</span>
              <input type="color" value={colors[key] ?? defaults[key]}
                onChange={(event) => onChange({ ...colors, [key]: event.target.value })} />
            </label>
            <button type="button" className="btn btn--ghost" disabled={!colors[key]}
              aria-label={`${label}跟随主题`}
              onClick={() => onChange({ ...colors, [key]: undefined })}>跟随主题</button>
          </div>
        ))}
        {error && <p className="editor-error" role="alert">{error}</p>}
        <div className="btn-row">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>取消</button>
          <button type="submit" className="btn btn--primary">保存</button>
        </div>
      </form>
    </div>
  </div>;
}
