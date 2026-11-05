import { useContext, useEffect, useRef, useState } from "react";
import { userUploadSource, type UserUpload } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import type { ComposerUpload } from "./useComposerUploads.ts";
import { TextAttachmentDialog } from "./TextAttachmentDialog.tsx";
import { editableTextFile } from "./pasted-text.ts";
import { AttachmentActionsContext } from "./AttachmentActions.tsx";

function byteSize(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(size / 1024))} KB`;
}

function ReselectUpload({
  item,
  disabled,
  choose,
  language,
}: {
  item: ComposerUpload;
  disabled: boolean;
  choose: (id: string, file: File) => void;
  language: string;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => picker.current?.click()}>
        {language === "zh-CN" ? "重新选择原文件" : "Select original file"}
      </button>
      <input
        type="file"
        hidden
        ref={picker}
        aria-label={`${language === "zh-CN" ? "重新选择" : "Reselect"} ${item.name}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) choose(item.id, file);
          event.target.value = "";
        }}
      />
    </>
  );
}

function UploadImage({ api, upload }: { api: PiCloudApi; upload: UserUpload }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    void api
      .readInputImage(upload, controller.signal)
      .then(({ bytes, contentType }) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: contentType }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, upload.sessionId, upload.id]);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={upload.name} />
    </a>
  ) : (
    <small>{t(failed ? "upload.previewFailed" : "common.loading")}</small>
  );
}

export function UploadCards({
  api,
  uploads,
  compact = false,
}: {
  api?: PiCloudApi;
  uploads?: readonly UserUpload[];
  compact?: boolean;
}) {
  const [opened, setOpened] = useState<UserUpload>();
  const onReuse = useContext(AttachmentActionsContext);
  const { language } = useI18n();
  if (!uploads?.length) return null;
  return (
    <>
      <div className={compact ? "upload-chips" : "upload-cards"}>
        {uploads.map((upload) => (
          <figure
            className={compact ? "upload-chip" : "upload-card"}
            key={upload.id}
            title={`${upload.name} · ${byteSize(upload.byteLength)} · ${upload.path}`}
          >
            {api && upload.image ? <UploadImage api={api} upload={upload} /> : null}
            <figcaption>
              {api && userUploadSource(upload) ? (
                editableTextFile(upload.name, upload.mimeType) ? (
                  <button
                    type="button"
                    className="attachment-name"
                    onClick={() => setOpened(upload)}
                  >
                    {upload.name}
                  </button>
                ) : (
                  <a href={api.attachmentDownloadUrl(upload)} download={upload.name}>
                    {upload.name}
                  </a>
                )
              ) : (
                <strong>{upload.name}</strong>
              )}
              {compact ? null : (
                <>
                  <small>{byteSize(upload.byteLength)}</small>
                  <code title={upload.path}>{upload.path}</code>
                </>
              )}
            </figcaption>
            {onReuse && userUploadSource(upload) && !compact ? (
              <button type="button" className="attachment-reuse" onClick={() => onReuse(upload)}>
                {language === "zh-CN" ? "重新使用" : "Reuse"}
              </button>
            ) : null}
          </figure>
        ))}
      </div>
      {opened ? (
        <TextAttachmentDialog
          name={opened.name}
          upload={opened}
          api={api}
          onReuse={onReuse ? () => onReuse(opened) : undefined}
          onClose={() => setOpened(undefined)}
        />
      ) : null}
    </>
  );
}

function LocalPreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url ? <img src={url} alt={file.name} /> : null;
}

export function ComposerUploadCards({
  items,
  disabled,
  remove,
  retry,
  edit,
  api,
  setRetention,
  pause,
  reselect,
}: {
  items: readonly ComposerUpload[];
  disabled: boolean;
  remove: (id: string) => void;
  retry: (id: string) => void;
  edit?: (id: string, text: string) => void;
  api?: PiCloudApi;
  setRetention?: (id: string, retention: "session" | "workspace") => void;
  pause?: (id: string) => void;
  reselect?: (id: string, file: File) => void;
}) {
  const { t, language } = useI18n();
  const [opened, setOpened] = useState<string>();
  const editing = items.find((item) => item.id === opened);
  return (
    <>
      <div className="upload-cards">
        {items.map((item) => (
          <div className="upload-card" key={item.id}>
            {item.file && ["image/png", "image/jpeg", "image/webp"].includes(item.file.type) ? (
              <LocalPreview file={item.file} />
            ) : null}
            {edit &&
            editableTextFile(
              item.name,
              item.file?.type ?? item.upload?.mimeType ?? item.source?.mimeType,
            ) ? (
              <button
                type="button"
                className="attachment-name"
                disabled={disabled || (!item.file && !item.upload && !item.source)}
                onClick={() => setOpened(item.id)}
              >
                {item.characters === undefined
                  ? item.name
                  : language === "zh-CN"
                    ? `粘贴内容 · ${item.characters.toLocaleString()} 字符`
                    : `Pasted text · ${item.characters.toLocaleString()} characters`}
              </button>
            ) : (
              <strong>{item.name}</strong>
            )}
            <small>
              {byteSize(item.size)}
              {item.status === "paused"
                ? language === "zh-CN"
                  ? " · 上传未完成"
                  : " · Upload paused"
                : item.deferred && item.status === "pending"
                  ? ""
                  : ` · ${t(`upload.${item.status}`)}`}
              {item.retention === "workspace" &&
              item.progress !== undefined &&
              item.status !== "ready"
                ? ` · ${Math.min(100, Math.floor((item.progress / item.size) * 100))}%`
                : ""}
            </small>
            {setRetention && item.characters === undefined && !item.source && !item.upload ? (
              <select
                aria-label={language === "zh-CN" ? "文件保存方式" : "File retention"}
                value={item.retention ?? "session"}
                disabled={disabled || item.started === true}
                onChange={(event) =>
                  setRetention(item.id, event.target.value as "session" | "workspace")
                }
              >
                <option value="session">
                  {language === "zh-CN" ? "随会话保留" : "Keep with conversation"}
                </option>
                <option value="workspace">
                  {language === "zh-CN" ? "仅工作区" : "Workspace only"}
                </option>
              </select>
            ) : null}
            {item.failure && item.status === "failed" ? (
              <small role="alert">{item.failure}</small>
            ) : null}
            <div>
              {(!item.file || item.status === "failed") &&
              !item.upload &&
              !item.source &&
              item.transfer?.state !== "ready" &&
              reselect ? (
                <ReselectUpload
                  item={item}
                  disabled={disabled}
                  choose={reselect}
                  language={language}
                />
              ) : null}
              {item.status === "uploading" && pause ? (
                <button type="button" onClick={() => pause(item.id)}>
                  {language === "zh-CN" ? "暂停" : "Pause"}
                </button>
              ) : null}
              {(item.status === "failed" || item.status === "paused") &&
              (item.file || item.source) ? (
                <button type="button" disabled={disabled} onClick={() => retry(item.id)}>
                  {item.status === "paused"
                    ? language === "zh-CN"
                      ? "继续上传"
                      : "Continue upload"
                    : t("common.retry")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={disabled && item.status !== "uploading"}
                aria-label={`${t("upload.remove")} ${item.name}`}
                onClick={() => remove(item.id)}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && edit ? (
        <TextAttachmentDialog
          name={editing.name}
          file={editing.file}
          upload={editing.upload ?? editing.source}
          api={api}
          onSave={disabled ? undefined : (text) => edit(editing.id, text)}
          onClose={() => setOpened(undefined)}
        />
      ) : null}
    </>
  );
}
