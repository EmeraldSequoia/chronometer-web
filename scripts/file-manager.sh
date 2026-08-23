#!/bin/bash
# file-manager.sh — Categorize, archive, and restore project files.
#
# Subcommands:
#   list              Show all files grouped by category
#   archive DEST      Archive category-5 files (minus archiveExclude)
#   restore SRC       Restore archived files into the project
#   archive-golden DEST  Archive test golden files (category 2)
#   restore-golden SRC   Restore test golden files
#
# See file-categories.json for category definitions.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CATEGORIES_FILE="$PROJECT_ROOT/file-categories.json"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

# Check that file-categories.json exists
[ -f "$CATEGORIES_FILE" ] || die "file-categories.json not found at $CATEGORIES_FILE"

# Resolve a path to be relative to PROJECT_ROOT (strip leading ./ if present)
relpath() {
    local p="$1"
    p="${p#$PROJECT_ROOT/}"
    p="${p#./}"
    echo "$p"
}

# Check if a path matches a pattern from file-categories.json.
# Supports:
#   "dir/"          — matches the directory and everything under it
#   "dir/file.ext"  — matches the exact file
#   "dir/*.ext"     — matches files with that extension directly in dir
path_matches_pattern() {
    local filepath="$1"  # relative to project root
    local pattern="$2"

    # Directory pattern: "some/dir/"
    if [[ "$pattern" == */ ]]; then
        local dir="${pattern%/}"
        [[ "$filepath" == "$dir" || "$filepath" == "$dir/"* ]] && return 0
        return 1
    fi

    # Glob pattern with *
    if [[ "$pattern" == *"*"* ]]; then
        # Convert to a bash glob check
        # e.g. "scripts/geonames-data/*.zip" should match "scripts/geonames-data/foo.zip"
        local dir_part="${pattern%/*}"
        local glob_part="${pattern##*/}"
        local file_dir="${filepath%/*}"
        local file_name="${filepath##*/}"

        if [[ "$file_dir" == "$dir_part" ]]; then
            # shellcheck disable=SC2254
            case "$file_name" in
                $glob_part) return 0 ;;
            esac
        fi
        return 1
    fi

    # Exact file match
    [[ "$filepath" == "$pattern" ]] && return 0
    return 1
}

# Get the category for a file path (relative to project root).
# Returns the category number, "2" for golden, or "" if no explicit rule matched.
get_explicit_category() {
    local filepath="$1"

    # Parse rules from file-categories.json using a simple approach:
    # Extract category and paths from each rule block.
    # We use node for reliable JSON parsing.
    local cat
    cat=$(node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CATEGORIES_FILE', 'utf8'));
        const fp = '$filepath';

        // Check ignore list
        for (const ig of cfg.ignore || []) {
            if (ig.endsWith('/')) {
                if (fp === ig.slice(0, -1) || fp.startsWith(ig)) {
                    console.log('IGNORE');
                    process.exit(0);
                }
            } else if (fp === ig) {
                console.log('IGNORE');
                process.exit(0);
            }
        }

        // Check rules in order (first match wins)
        for (const rule of cfg.rules) {
            for (const pattern of rule.paths) {
                // Directory pattern
                if (pattern.endsWith('/')) {
                    const dir = pattern.slice(0, -1);
                    if (fp === dir || fp.startsWith(dir + '/')) {
                        console.log(rule.category);
                        process.exit(0);
                    }
                }
                // Glob pattern
                else if (pattern.includes('*')) {
                    const dirPart = pattern.substring(0, pattern.lastIndexOf('/'));
                    const globPart = pattern.substring(pattern.lastIndexOf('/') + 1);
                    const fileDir = fp.substring(0, fp.lastIndexOf('/'));
                    const fileName = fp.substring(fp.lastIndexOf('/') + 1);
                    if (fileDir === dirPart) {
                        const re = new RegExp('^' + globPart.replace(/\\./g, '\\\\.').replace(/\\*/g, '.*') + '$');
                        if (re.test(fileName)) {
                            console.log(rule.category);
                            process.exit(0);
                        }
                    }
                }
                // Exact match
                else if (fp === pattern) {
                    console.log(rule.category);
                    process.exit(0);
                }
            }
        }
        // No explicit rule matched
        console.log('');
    ")
    echo "$cat"
}

# ─────────────────────────────────────────────────────────────────────────────
# list — Categorize and display all files
# ─────────────────────────────────────────────────────────────────────────────

cmd_list() {
    cd "$PROJECT_ROOT"

    # Build set of git-tracked files
    local git_files_tmp
    git_files_tmp=$(mktemp)
    git ls-files > "$git_files_tmp"

    # Build set of gitignored paths (directories collapsed to "dir/")
    local ignored_tmp
    ignored_tmp=$(mktemp)
    git ls-files --others --ignored --exclude-standard --directory > "$ignored_tmp"

    # Collect all FILES only (excluding .git/, .DS_Store, and directories)
    local all_files_tmp
    all_files_tmp=$(mktemp)
    find . -not -path './.git/*' -not -path './.git' -not -name '.DS_Store' -type f \
        | sed 's|^\./||' | sort > "$all_files_tmp"

    # Categorize every file using node for performance (avoids per-file subprocess)
    node -e "
        const fs = require('fs');
        const path = require('path');
        const cfg = JSON.parse(fs.readFileSync('$CATEGORIES_FILE', 'utf8'));
        const gitFiles = new Set(fs.readFileSync('$git_files_tmp', 'utf8').trim().split('\n'));
        const ignoredPaths = fs.readFileSync('$ignored_tmp', 'utf8').trim().split('\n').filter(p => p);
        const allFiles = fs.readFileSync('$all_files_tmp', 'utf8').trim().split('\n').filter(f => f);

        const catNames = {
            '1': 'Ephemeral build output',
            '2': 'Rebuildable without Internet',
            '3': 'Git-tracked',
            '4': 'Reference (not build sources)',
            '5': 'Internet-downloaded',
        };

        function matchesPattern(fp, pattern) {
            if (pattern.endsWith('/')) {
                const dir = pattern.slice(0, -1);
                return fp === dir || fp.startsWith(dir + '/');
            }
            if (pattern.includes('*')) {
                const dirPart = pattern.substring(0, pattern.lastIndexOf('/'));
                const globPart = pattern.substring(pattern.lastIndexOf('/') + 1);
                const fileDir = fp.substring(0, fp.lastIndexOf('/'));
                const fileName = fp.substring(fp.lastIndexOf('/') + 1);
                if (fileDir === dirPart) {
                    const re = new RegExp('^' + globPart.replace(/\\./g, '\\\\.').replace(/\\*/g, '.*') + '\$');
                    return re.test(fileName);
                }
                return false;
            }
            return fp === pattern;
        }

        // Is this path gitignored? ignoredPaths holds files plus collapsed \"dir/\" entries.
        function isIgnored(fp) {
            for (const ig of ignoredPaths) {
                if (ig.endsWith('/')) {
                    if (fp === ig.slice(0, -1) || fp.startsWith(ig)) return true;
                } else if (fp === ig) {
                    return true;
                }
            }
            return false;
        }

        function categorize(fp) {
            // Check ignore
            for (const ig of cfg.ignore || []) {
                if (ig.endsWith('/') && (fp === ig.slice(0, -1) || fp.startsWith(ig))) {
                    return 'IGNORE';
                }
                if (fp === ig) return 'IGNORE';
            }

            // Check explicit rules (first match wins)
            for (const rule of cfg.rules) {
                for (const pattern of rule.paths) {
                    if (matchesPattern(fp, pattern)) {
                        return String(rule.category);
                    }
                }
            }

            // Fallback: git-tracked → category 3
            if (gitFiles.has(fp)) return '3';

            // Gitignored and untracked: it will never be committed, so calling it
            // category 3 (\"Git-tracked\") would be a lie. These are exactly the files
            // archival has to reason about, so every one needs an explicit rule (or an
            // 'ignore' entry) in file-categories.json — report the gaps instead.
            if (isIgnored(fp)) return 'UNKNOWN';

            // Untracked but not ignored: a new working-tree file on its way into git.
            return '3';
        }

        // Categorize all files
        const fileCats = new Map();
        const unknowns = [];
        for (const fp of allFiles) {
            const cat = categorize(fp);
            if (cat === 'IGNORE') continue;
            if (cat === 'UNKNOWN') {
                unknowns.push(fp);
                continue;
            }
            fileCats.set(fp, cat);
        }


        // Group files by category
        const byCat = {};
        for (const [fp, cat] of fileCats) {
            if (!byCat[cat]) byCat[cat] = [];
            byCat[cat].push(fp);
        }

        // Helper: collapse directory trees recursively.
        // For a given category's file list, build a trie from path segments,
        // then collapse bottom-up: if ALL files under a dir (across ALL categories)
        // share the same category, show just the directory.
        function collapseEntries(catFiles, cat) {
            const result = [];

            // Build a trie of the catFiles
            const root = { children: new Map(), files: [] };
            for (const f of catFiles) {
                const parts = f.split('/');
                let node = root;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!node.children.has(parts[i])) {
                        node.children.set(parts[i], { children: new Map(), files: [] });
                    }
                    node = node.children.get(parts[i]);
                }
                node.files.push(f);
            }

            // Check if ALL files under a directory path (across all categories) belong to cat
            function isDirUniform(dirPath) {
                const prefix = dirPath + '/';
                for (const f of allFiles) {
                    if (f.startsWith(prefix)) {
                        if (fileCats.get(f) !== cat) return false;
                    }
                }
                return true;
            }

            // Count files under a directory that belong to this category
            function countFiles(dirPath) {
                const prefix = dirPath + '/';
                let n = 0;
                for (const f of catFiles) {
                    if (f.startsWith(prefix)) n++;
                }
                return n;
            }

            // Walk the trie and emit entries
            function walk(node, pathPrefix) {
                // Emit leaf files at this level
                for (const f of node.files) {
                    result.push({ path: f, count: null });
                }

                // Process child directories
                for (const [name, child] of node.children) {
                    const dirPath = pathPrefix ? pathPrefix + '/' + name : name;

                    if (isDirUniform(dirPath)) {
                        // All files under this dir are the same category — collapse
                        const n = countFiles(dirPath);
                        result.push({ path: dirPath + '/', count: n });
                    } else {
                        // Mixed — recurse deeper
                        walk(child, dirPath);
                    }
                }
            }

            walk(root, '');
            result.sort((a, b) => a.path.localeCompare(b.path));
            return result;
        }

        // Helper: human-readable file size
        function formatBytes(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        }

        // Human-readable file size for a single file
        function fileSize(fp) {
            try {
                const stat = fs.statSync(fp);
                if (stat.isDirectory()) return '';
                return formatBytes(stat.size);
            } catch { return ''; }
        }

        // Total size of all files under a directory
        function dirSize(dirPath) {
            const prefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';
            let total = 0;
            for (const f of allFiles) {
                if (f.startsWith(prefix)) {
                    try { total += fs.statSync(f).size; } catch {}
                }
            }
            return formatBytes(total);
        }

        // Print results
        const catOrder = ['1', '2', '3', '4', '5'];
        for (const cat of catOrder) {
            const files = byCat[cat] || [];
            if (files.length === 0) continue;

            console.log();
            console.log('Category ' + cat + ' (' + catNames[cat] + '):');

            const entries = collapseEntries(files, cat);
            for (const entry of entries) {
                let line = '  ' + entry.path;
                if (entry.count !== null) {
                    const sz = dirSize(entry.path);
                    line += '  (' + entry.count + ' files, ' + sz + ')';
                } else {
                    const sz = fileSize(entry.path);
                    if (sz) line += '  (' + sz + ')';
                }
                console.log(line);
            }
        }

        if (unknowns.length > 0) {
            console.log();
            console.log('UNCATEGORIZED (errors — every gitignored file needs a rule in');
            console.log('file-categories.json, or an entry in its \"ignore\" list):');
            for (const u of unknowns.slice(0, 20)) {
                console.log('  ' + u);
            }
            if (unknowns.length > 20) {
                console.log('  ... and ' + (unknowns.length - 20) + ' more');
            }
            process.exit(1);
        }

        console.log();
        console.log('All files categorized successfully.');
    "

    rm -f "$git_files_tmp" "$ignored_tmp" "$all_files_tmp"
}

# ─────────────────────────────────────────────────────────────────────────────
# Helpers for archive/restore: get list of archivable paths
# ─────────────────────────────────────────────────────────────────────────────

# Get list of files to archive (category 2 + category 5, minus archiveExclude).
# For the main archive, this is category-5 files only (cat-2 is golden-only).
# For golden archive, this is category-2 files.
get_archive_files() {
    local mode="$1"  # "main" or "golden"
    cd "$PROJECT_ROOT"

    node -e "
        const fs = require('fs');
        const path = require('path');
        const cfg = JSON.parse(fs.readFileSync('$CATEGORIES_FILE', 'utf8'));
        const mode = '$mode';

        function matchesPattern(fp, pattern) {
            if (pattern.endsWith('/')) {
                const dir = pattern.slice(0, -1);
                return fp === dir || fp.startsWith(dir + '/');
            }
            if (pattern.includes('*')) {
                const dirPart = pattern.substring(0, pattern.lastIndexOf('/'));
                const globPart = pattern.substring(pattern.lastIndexOf('/') + 1);
                const fileDir = fp.substring(0, fp.lastIndexOf('/'));
                const fileName = fp.substring(fp.lastIndexOf('/') + 1);
                if (fileDir === dirPart) {
                    const re = new RegExp('^' + globPart.replace(/\\./g, '\\\\.').replace(/\\*/g, '.*') + '\$');
                    return re.test(fileName);
                }
                return false;
            }
            return fp === pattern;
        }

        // Determine which categories to archive
        const targetCats = mode === 'golden' ? [2] : [5];
        const excludes = cfg.archiveExclude || [];

        // Collect paths from matching rules
        const archivePaths = [];
        for (const rule of cfg.rules) {
            if (!targetCats.includes(rule.category)) continue;
            for (const pattern of rule.paths) {
                // Check if excluded
                let excluded = false;
                for (const ex of excludes) {
                    if (matchesPattern(pattern.replace(/\/$/, ''), ex.replace(/\/$/, '')) ||
                        pattern === ex) {
                        excluded = true;
                        break;
                    }
                }
                if (excluded) continue;
                archivePaths.push(pattern);
            }
        }

        // Expand paths to actual files
        function expandPath(p) {
            const results = [];
            if (p.endsWith('/')) {
                // Directory — find all files recursively
                const dir = p.slice(0, -1);
                if (!fs.existsSync(dir)) return results;
                function walk(d) {
                    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                        const full = path.join(d, entry.name);
                        if (entry.isDirectory()) walk(full);
                        else results.push(full);
                    }
                }
                walk(dir);
            } else if (p.includes('*')) {
                // Glob — expand manually
                const dirPart = p.substring(0, p.lastIndexOf('/'));
                const globPart = p.substring(p.lastIndexOf('/') + 1);
                const re = new RegExp('^' + globPart.replace(/\\./g, '\\\\.').replace(/\\*/g, '.*') + '\$');
                if (fs.existsSync(dirPart)) {
                    for (const f of fs.readdirSync(dirPart)) {
                        if (re.test(f)) {
                            const full = path.join(dirPart, f);
                            if (fs.statSync(full).isFile()) results.push(full);
                        }
                    }
                }
            } else {
                if (fs.existsSync(p)) results.push(p);
            }
            return results;
        }

        const allFiles = [];
        for (const p of archivePaths) {
            allFiles.push(...expandPath(p));
        }

        for (const f of allFiles.sort()) {
            console.log(f);
        }
    "
}

# ─────────────────────────────────────────────────────────────────────────────
# archive — Archive category-5 files (excl. node_modules)
# ─────────────────────────────────────────────────────────────────────────────

cmd_archive() {
    local dest="$1"
    [ -z "$dest" ] && die "Usage: $0 archive <destination-path>"

    # Resolve to absolute path
    dest="$(cd "$(dirname "$dest")" 2>/dev/null && pwd)/$(basename "$dest")" || \
        die "Parent directory of $dest does not exist"

    # Check destination is not inside project tree
    case "$dest" in
        "$PROJECT_ROOT"/*) die "Destination must not be inside the project tree: $dest" ;;
    esac

    # Check destination doesn't already exist
    [ -e "$dest" ] && die "Destination already exists: $dest. Remove it first or choose a different path."

    cd "$PROJECT_ROOT"

    echo "=== Archiving category-5 files (excl. node_modules) ==="
    echo "  Source:      $PROJECT_ROOT"
    echo "  Destination: $dest"
    echo

    # Get file list
    local files_tmp
    files_tmp=$(mktemp)
    get_archive_files "main" > "$files_tmp"

    local count
    count=$(wc -l < "$files_tmp" | tr -d ' ')
    if [ "$count" -eq 0 ]; then
        echo "No files to archive."
        rm -f "$files_tmp"
        return 0
    fi

    echo "  $count files to archive"
    mkdir -p "$dest"

    # Copy files preserving directory structure
    while IFS= read -r file; do
        local dest_file="$dest/$file"
        mkdir -p "$(dirname "$dest_file")"
        cp "$file" "$dest_file"
        echo "  → $file"
    done < "$files_tmp"

    # Generate manifest with SHA-256 checksums
    echo
    echo "=== Generating manifest ==="
    local manifest="$dest/MANIFEST.sha256"
    while IFS= read -r file; do
        shasum -a 256 "$file" >> "$manifest"
    done < "$files_tmp"
    echo "  → MANIFEST.sha256 ($count entries)"

    rm -f "$files_tmp"

    # Compress the archive directory into a .tar.gz
    echo
    echo "=== Compressing archive ==="
    local archive_file="${dest}.tar.gz"
    tar czf "$archive_file" -C "$(dirname "$dest")" "$(basename "$dest")"
    rm -rf "$dest"
    local compressed_size
    compressed_size=$(du -sh "$archive_file" | cut -f1)
    echo "  → $(basename "$archive_file") ($compressed_size)"
    echo
    echo "=== Archive complete: $archive_file ==="
}

# ─────────────────────────────────────────────────────────────────────────────
# restore — Restore archived files into a clean checkout
# ─────────────────────────────────────────────────────────────────────────────

cmd_restore() {
    local src="$1"
    [ -z "$src" ] && die "Usage: $0 restore <source-path>"

    # If source is a .tar.gz, decompress to a temp directory
    local tmp_extract=""
    if [[ "$src" == *.tar.gz ]] || [[ "$src" == *.tgz ]]; then
        [ -f "$src" ] || die "Archive file does not exist: $src"
        # Resolve to absolute path
        src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
        tmp_extract=$(mktemp -d)
        echo "=== Decompressing archive ==="
        tar xzf "$src" -C "$tmp_extract"
        # Find the extracted directory (should be exactly one)
        local extracted_dir
        extracted_dir=$(find "$tmp_extract" -mindepth 1 -maxdepth 1 -type d | head -1)
        [ -n "$extracted_dir" ] || die "No directory found inside archive"
        src="$extracted_dir"
        echo "  → Extracted to temporary directory"
        echo
    else
        # Resolve to absolute path
        src="$(cd "$src" 2>/dev/null && pwd)" || die "Source directory does not exist: $1"
    fi

    [ -f "$src/MANIFEST.sha256" ] || die "No MANIFEST.sha256 found in $src — is this a valid archive?"

    cd "$PROJECT_ROOT"

    echo "=== Restoring from archive ==="
    echo "  Source:      $src"
    echo "  Destination: $PROJECT_ROOT"
    echo

    # Check for conflicts: any archived file that already exists in the project
    local conflicts=()
    while IFS= read -r line; do
        local file
        file=$(echo "$line" | awk '{print $2}')
        if [ -f "$file" ]; then
            conflicts+=("$file")
        fi
    done < "$src/MANIFEST.sha256"

    if [ ${#conflicts[@]} -gt 0 ]; then
        echo "ERROR: The following files already exist in the project and would be overwritten:" >&2
        for f in "${conflicts[@]}"; do
            echo "  $f" >&2
        done
        echo >&2
        echo "Remove these files first if you want to restore from the archive." >&2
        exit 1
    fi

    # Copy files from archive
    local count=0
    while IFS= read -r line; do
        local file
        file=$(echo "$line" | awk '{print $2}')
        if [ -f "$src/$file" ]; then
            mkdir -p "$(dirname "$file")"
            cp "$src/$file" "$file"
            echo "  → $file"
            count=$((count + 1))
        else
            echo "  WARNING: $file listed in manifest but not found in archive" >&2
        fi
    done < "$src/MANIFEST.sha256"

    # Verify checksums
    echo
    echo "=== Verifying checksums ==="
    if shasum -a 256 -c "$src/MANIFEST.sha256" --quiet 2>/dev/null; then
        echo "  ✓ All checksums verified ($count files)"
    else
        echo "  WARNING: Checksum verification failed for one or more files" >&2
        shasum -a 256 -c "$src/MANIFEST.sha256" 2>&1 | grep -i fail >&2
        exit 1
    fi

    echo
    echo "=== Restore complete ==="
    echo
    echo "Reminder: You also need to run 'npm install' to restore node_modules/."

    # Clean up temp extraction directory if we created one
    [ -n "$tmp_extract" ] && rm -rf "$tmp_extract"
}

# ─────────────────────────────────────────────────────────────────────────────
# archive-golden — Archive test golden files (category 2)
# ─────────────────────────────────────────────────────────────────────────────

cmd_archive_golden() {
    local dest="$1"
    [ -z "$dest" ] && die "Usage: $0 archive-golden <destination-path>"

    dest="$(cd "$(dirname "$dest")" 2>/dev/null && pwd)/$(basename "$dest")" || \
        die "Parent directory of $dest does not exist"

    case "$dest" in
        "$PROJECT_ROOT"/*) die "Destination must not be inside the project tree: $dest" ;;
    esac

    [ -e "$dest" ] && die "Destination already exists: $dest. Remove it first or choose a different path."

    cd "$PROJECT_ROOT"

    echo "=== Archiving test golden files ==="
    echo "  Source:      $PROJECT_ROOT"
    echo "  Destination: $dest"
    echo

    local files_tmp
    files_tmp=$(mktemp)
    get_archive_files "golden" > "$files_tmp"

    local count
    count=$(wc -l < "$files_tmp" | tr -d ' ')
    if [ "$count" -eq 0 ]; then
        echo "No golden files to archive."
        rm -f "$files_tmp"
        return 0
    fi

    echo "  $count files to archive"
    mkdir -p "$dest"

    while IFS= read -r file; do
        local dest_file="$dest/$file"
        mkdir -p "$(dirname "$dest_file")"
        cp "$file" "$dest_file"
        echo "  → $file"
    done < "$files_tmp"

    echo
    echo "=== Generating manifest ==="
    local manifest="$dest/MANIFEST.sha256"
    while IFS= read -r file; do
        shasum -a 256 "$file" >> "$manifest"
    done < "$files_tmp"
    echo "  → MANIFEST.sha256 ($count entries)"

    rm -f "$files_tmp"

    # Compress the archive directory into a .tar.gz
    echo
    echo "=== Compressing archive ==="
    local archive_file="${dest}.tar.gz"
    tar czf "$archive_file" -C "$(dirname "$dest")" "$(basename "$dest")"
    rm -rf "$dest"
    local compressed_size
    compressed_size=$(du -sh "$archive_file" | cut -f1)
    echo "  → $(basename "$archive_file") ($compressed_size)"
    echo
    echo "=== Golden archive complete: $archive_file ==="
}

# ─────────────────────────────────────────────────────────────────────────────
# restore-golden — Restore test golden files
# ─────────────────────────────────────────────────────────────────────────────

cmd_restore_golden() {
    local src="$1"
    [ -z "$src" ] && die "Usage: $0 restore-golden <source-path>"

    # If source is a .tar.gz, decompress to a temp directory
    local tmp_extract=""
    if [[ "$src" == *.tar.gz ]] || [[ "$src" == *.tgz ]]; then
        [ -f "$src" ] || die "Archive file does not exist: $src"
        src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
        tmp_extract=$(mktemp -d)
        echo "=== Decompressing archive ==="
        tar xzf "$src" -C "$tmp_extract"
        local extracted_dir
        extracted_dir=$(find "$tmp_extract" -mindepth 1 -maxdepth 1 -type d | head -1)
        [ -n "$extracted_dir" ] || die "No directory found inside archive"
        src="$extracted_dir"
        echo "  → Extracted to temporary directory"
        echo
    else
        src="$(cd "$src" 2>/dev/null && pwd)" || die "Source directory does not exist: $1"
    fi

    [ -f "$src/MANIFEST.sha256" ] || die "No MANIFEST.sha256 found in $src — is this a valid archive?"

    cd "$PROJECT_ROOT"

    echo "=== Restoring test golden files ==="
    echo "  Source:      $src"
    echo "  Destination: $PROJECT_ROOT"
    echo

    # Check for conflicts
    local conflicts=()
    while IFS= read -r line; do
        local file
        file=$(echo "$line" | awk '{print $2}')
        if [ -f "$file" ]; then
            conflicts+=("$file")
        fi
    done < "$src/MANIFEST.sha256"

    if [ ${#conflicts[@]} -gt 0 ]; then
        echo "ERROR: The following golden files already exist and would be overwritten:" >&2
        printf "  %s\n" "${conflicts[@]}" >&2
        echo >&2
        echo "Remove these files first if you want to restore from the archive." >&2
        exit 1
    fi

    local count=0
    while IFS= read -r line; do
        local file
        file=$(echo "$line" | awk '{print $2}')
        if [ -f "$src/$file" ]; then
            mkdir -p "$(dirname "$file")"
            cp "$src/$file" "$file"
            echo "  → $file"
            count=$((count + 1))
        else
            echo "  WARNING: $file listed in manifest but not found in archive" >&2
        fi
    done < "$src/MANIFEST.sha256"

    echo
    echo "=== Verifying checksums ==="
    if shasum -a 256 -c "$src/MANIFEST.sha256" --quiet 2>/dev/null; then
        echo "  ✓ All checksums verified ($count files)"
    else
        echo "  WARNING: Checksum verification failed for one or more files" >&2
        shasum -a 256 -c "$src/MANIFEST.sha256" 2>&1 | grep -i fail >&2
        exit 1
    fi

    echo
    echo "=== Golden file restore complete ==="

    # Clean up temp extraction directory if we created one
    [ -n "$tmp_extract" ] && rm -rf "$tmp_extract"
}

# ─────────────────────────────────────────────────────────────────────────────
# Main dispatcher
# ─────────────────────────────────────────────────────────────────────────────

case "${1:-}" in
    list)           cmd_list ;;
    archive)        cmd_archive "$2" ;;
    restore)        cmd_restore "$2" ;;
    archive-golden) cmd_archive_golden "$2" ;;
    restore-golden) cmd_restore_golden "$2" ;;
    *)
        echo "Usage: $0 <command> [args]"
        echo
        echo "Commands:"
        echo "  list                    Show all files grouped by category"
        echo "  archive <dest>          Archive category-5 files (minus archiveExclude) to <dest>.tar.gz"
        echo "  restore <src>           Restore archived files from <src> (.tar.gz or directory)"
        echo "  archive-golden <dest>   Archive test golden files to <dest>.tar.gz"
        echo "  restore-golden <src>    Restore test golden files from <src> (.tar.gz or directory)"
        echo
        echo "See file-categories.json for category definitions."
        exit 1
        ;;
esac
