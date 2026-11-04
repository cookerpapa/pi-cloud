import { useEffect, useRef, useState } from "react";
import { userUploadSource, type UserUpload } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { characterCount, decodeAttachmentText, MAX_TEXT_EDITOR_BYTES } from "./pasted-text.ts";

export function TextAttachmentDialog({
  name,
  file,
  upload,
  api,
  onSave,
  onReuse,
  onClose,
}: {
  name: string;
  file?: File | undefined;
  upload?: UserUpload | undefined;
  api?: PiCloudApi | undefined;
  onSave?: ((text: string) => void) | undefined;
  onReuse?: (() => void) | undefined;
  onClose(): void;
}) {
  const { language, t } = useI18n();
  const say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string>();
  const [localDownload, setLocalDownload] = useState<string>();
  const [failed, setFailed] = useState(false);
  const tooLarge = (file?.size ?? upload?.byteLength ?? 0) > MAX_TEXT_EDITOR_BYTES;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!file) {
      setLocalDownload(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalDownload(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    const abort = new AbortController();
    setText(undefined);
    setFailed(false);
    if (!tooLarge)
      void (async () => {
        const bytes = file
          ? new Uint8Array(await file.arrayBuffer())
          : upload && api
            ? (await api.readInputAttachment(upload, abort.signal)).bytes
            : undefined;
        if (!bytes) throw new Error("Attachment is unavailable");
        const value = decodeAttachmentText(bytes);
        if (!abort.signal.aborted) setText(value);
      })().catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [api, file, upload, tooLarge]);
  return (
    <dialog
      ref={dialog}
      className="text-attachment-dialog"
      aria-label={name}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <strong>{name}</strong>
        <button type="button" aria-label={t("common.close")} onClick={onClose}>
          ×
        </button>
      </header>
      {tooLarge ? (
        <p>{say("文件较大，请下载查看。", "Download this large file to view it.")}</p>
      ) : failed ? (
        <p role="alert">
          {say(
            "无法打开文本原件，请重试或下载。",
            "Cannot open the text original. Retry or download it.",
          )}
        </p>
      ) : text === undefined ? (
        <p role="status">{t("common.loading")}</p>
      ) : (
        <textarea
          aria-label={say("附件内容", "Attachment content")}
          value={text}
          readOnly={!onSave}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <footer>
        <small>
          {text === undefined
            ? ""
            : say(
                `${characterCount(text).toLocaleString()} 字符`,
                `${characterCount(text).toLocaleString()} characters`,
              )}
        </small>
        {localDownload ? (
          <a href={localDownload} download={name}>
            {say("下载", "Download")}
          </a>
        ) : upload && api && userUploadSource(upload) ? (
          <a href={api.attachmentDownloadUrl(upload)} download={name}>
            {say("下载", "Download")}
          </a>
        ) : null}
        {onReuse ? (
          <button
            type="button"
            onClick={() => {
              onReuse();
              onClose();
            }}
          >
            {say("重新使用", "Reuse")}
          </button>
        ) : null}
        {onSave ? (
          <button
            type="button"
            disabled={!text || failed || tooLarge}
            onClick={() => {
              try {
                onSave(text!);
                onClose();
              } catch {
                setFailed(true);
              }
            }}
          >
            {say("保存", "Save")}
          </button>
        ) : null}
      </footer>
    </dialog>
  );
}
