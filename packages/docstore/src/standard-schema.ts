/** The Standard Schema v1 interface (standardschema.dev), copied as its spec invites, so validating needs no dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export type InferInput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
export type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
