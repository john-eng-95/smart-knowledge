declare module 'snowflake-id' {
  interface SnowflakeIdOptions {
    /** Worker ID (0-1023); each instance must be unique in a distributed deployment. */
    mid?: number;
    /** Epoch offset in milliseconds, subtracted from the current time. */
    offset?: number;
  }

  class SnowflakeId {
    constructor(options?: SnowflakeIdOptions);
    /** Generate a Snowflake ID string because JS numbers cannot safely represent 64-bit integers. */
    generate(): string;
  }

  export = SnowflakeId;
}
