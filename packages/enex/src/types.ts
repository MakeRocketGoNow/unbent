/** A binary attachment carried inside a note, decoded from base64. */
export interface EnexResource {
  /** MD5 of the decoded bytes. Computed, not read: ENEX resources carry no hash. */
  md5: string;
  /** From `<file-name>`, or synthesized from the md5 and mime when absent. */
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

/** One `<note>` from an ENEX file, after parsing but before conversion. */
export interface EnexNote {
  title: string;
  /** Raw ENML: the HTML dialect inside `<content>`. */
  enml: string;
  created?: Date;
  updated?: Date;
  tags: string[];
  sourceUrl?: string;
  resources: EnexResource[];
}

/** A note converted to markdown, ready to send to the API. */
export interface ConvertedNote {
  title: string;
  /** Markdown body. Attachment links are relative: `files/<name>`. */
  body: string;
  tags: string[];
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
  /** sha256 of title + body, for idempotent re-import. */
  contentHash: string;
  /** Attachments actually referenced or carried by this note. */
  files: Array<{ filename: string; mime: string; bytes: Uint8Array }>;
}
