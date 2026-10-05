/** Trusted local proof that a record never entered publication. A remote error
 * or missing PG row does not establish this classification. */
export class PublicationNotSentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicationNotSentError";
  }
}
