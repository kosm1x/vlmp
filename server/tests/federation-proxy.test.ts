import { describe, it, expect } from "vitest";
import { stripSensitiveFields } from "../src/federation/proxy.js";

describe("Federation Proxy", () => {
  it("stripSensitiveFields removes file_path, file_size, library_folder_id", () => {
    const item = {
      id: 1,
      title: "Test Movie",
      file_path: "/secret/path/movie.mp4",
      file_size: 123456789,
      library_folder_id: 5,
      poster_path: "/poster.jpg",
    };
    const stripped = stripSensitiveFields(item, 10, "Remote Server");
    expect(stripped).not.toHaveProperty("file_path");
    expect(stripped).not.toHaveProperty("file_size");
    expect(stripped).not.toHaveProperty("library_folder_id");
    expect(stripped.id).toBe(1);
    expect(stripped.title).toBe("Test Movie");
    expect(stripped.poster_path).toBe("/poster.jpg");
    expect(stripped.server_id).toBe(10);
    expect(stripped.server_name).toBe("Remote Server");
  });

  it("stripSensitiveFields handles item without sensitive fields", () => {
    const item = { id: 2, title: "Clean Item" };
    const stripped = stripSensitiveFields(item, 3, "Server B");
    expect(stripped.id).toBe(2);
    expect(stripped.title).toBe("Clean Item");
    expect(stripped.server_id).toBe(3);
    expect(stripped.server_name).toBe("Server B");
  });

  it("stripSensitiveFields does not mutate original", () => {
    const item = {
      id: 1,
      file_path: "/path",
      file_size: 100,
      library_folder_id: 1,
    };
    stripSensitiveFields(item, 1, "S");
    expect(item.file_path).toBe("/path");
    expect(item.file_size).toBe(100);
    expect(item.library_folder_id).toBe(1);
  });
});
