# Only change the static site's root location. Leave API, TLS, headers and
# hostname redirects alone. Refuse unfamiliar layouts instead of guessing.
/^[[:space:]]*location[[:space:]]+\/[[:space:]]*\{[[:space:]]*$/ {
    in_root = 1
    roots++
    print
    next
}
in_root && /\{/ { invalid = 1 }
in_root && /^[[:space:]]*try_files[[:space:]]/ {
    if ($0 ~ /^[[:space:]]*try_files[[:space:]]+\$uri[[:space:]]+\$uri\/[[:space:]]+(\/index\.html|=404)[[:space:]]*;[[:space:]]*(#.*)?$/) {
        sub(/\/index\.html[[:space:]]*;/, "=404;")
        routes++
    } else {
        invalid = 1
    }
}
in_root && /^[[:space:]]*\}[[:space:]]*$/ { in_root = 0 }
{ print }
END {
    if (invalid || in_root || roots != 1 || routes != 1) {
        print "Unrecognized static routing; refusing to install Nginx configuration." > "/dev/stderr"
        exit 1
    }
}
