import type { GraphRecord } from "@rs-graph/core-schema";

export interface RecordSink {
  write(record: GraphRecord): void;
}

export class NdjsonSink implements RecordSink {
  constructor(private readonly stream: NodeJS.WritableStream) {}

  write(record: GraphRecord): void {
    this.stream.write(JSON.stringify(record) + "\n");
  }
}

export class ArraySink implements RecordSink {
  readonly records: GraphRecord[] = [];

  write(record: GraphRecord): void {
    this.records.push(record);
  }
}
