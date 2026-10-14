export function buildZip(entries: [name: string, content: string][]): Buffer {
    const records: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;

    for (const [name, content] of entries) {
        const nameBytes = Buffer.from(name);
        const data = Buffer.from(content);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);

        records.push(local, nameBytes, data);
        directory.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
    }

    const directoryBytes = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...records, directoryBytes, end]);
}
