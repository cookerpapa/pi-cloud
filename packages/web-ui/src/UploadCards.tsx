import { useEffect, useState } from "react";
import type { UserUpload } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import type { ComposerUpload } from "./useComposerUploads.ts";

function byteSize(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(size / 1024))} KB`;
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
  if (!uploads?.length) return null;
  return (
    <div className={compact ? "upload-chips" : "upload-cards"}>
      {uploads.map((upload) => (
        <figure
          className={compact ? "upload-chip" : "upload-card"}
          key={upload.id}
          title={`${upload.name} · ${byteSize(upload.byteLength)} · ${upload.path}`}
        >
          {api && upload.image ? <UploadImage api={api} upload={upload} /> : null}
          <figcaption>
            <strong>{upload.name}</strong>
            {compact ? null : (
              <>
                <small>{byteSize(upload.byteLength)}</small>
                <code title={upload.path}>{upload.path}</code>
              </>
            )}
          </figcaption>
        </figure>
      ))}
    </div>
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
}: {
  items: readonly ComposerUpload[];
  disabled: boolean;
  remove: (id: string) => void;
  retry: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="upload-cards">
      {items.map((item) => (
        <div className="upload-card" key={item.id}>
          {item.file && ["image/png", "image/jpeg", "image/webp"].includes(item.file.type) ? (
            <LocalPreview file={item.file} />
          ) : null}
          <strong>{item.name}</strong>
          <small>
            {byteSize(item.size)} · {t(`upload.${item.status}`)}
          </small>
          <div>
            {item.status === "failed" ? (
              <button type="button" disabled={disabled} onClick={() => retry(item.id)}>
                {t("common.retry")}
              </button>
            ) : null}
            <button
              type="button"
              disabled={disabled}
              aria-label={`${t("upload.remove")} ${item.name}`}
              onClick={() => remove(item.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
