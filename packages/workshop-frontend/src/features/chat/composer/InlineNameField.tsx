import { useRef, useState } from "react";
import { Input } from "@cloudflare/kumo";
import { MAX_CHAT_PRESET_NAME_LENGTH } from "@gadgets/workshop-shared/api";
import { isImeComposing } from "../../../keyboardEvent";

/** Marks an inline name field, in which Escape cancels the edit rather than closing the settings. */
export const INLINE_NAME_FIELD = "data-chat-settings-editor";

/**
 * A preset's name typed in place: Enter saves it, trimmed, and Escape cancels. A name that is
 * blank once trimmed saves nothing.
 */
export const InlineNameField = ({ label, initial, onSave, onCancel, saveOnBlur = false }: {
  label: string;
  initial: string;
  /** `refocus` is false when the field is left, since focus has then gone where it was sent. */
  onSave: (name: string, refocus: boolean) => void;
  onCancel: (refocus: boolean) => void;
  /** Whether leaving the field saves the name, rather than leaving it open. */
  saveOnBlur?: boolean;
}) => {
  const [name, setName] = useState(initial);
  // Saving or cancelling unmounts the field, whose blur must then do nothing more.
  const done = useRef(false);
  const finish = (save: boolean, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    const trimmed = name.trim();
    if (save && trimmed) onSave(trimmed, refocus);
    else onCancel(refocus);
  };

  return (
    <Input
      {...{ [INLINE_NAME_FIELD]: "" }}
      aria-label={label}
      placeholder={label}
      autoFocus
      size="sm"
      className="w-full"
      value={name}
      maxLength={MAX_CHAT_PRESET_NAME_LENGTH}
      onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => {
        if (isImeComposing(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false, true);
        }
      }}
      onBlur={saveOnBlur ? () => finish(true, false) : undefined}
    />
  );
};
