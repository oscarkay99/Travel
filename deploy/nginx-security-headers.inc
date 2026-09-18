# BEGIN ROGERNORT MANAGED SECURITY HEADERS
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-/KCsfpMCB0Kx2RbNQn6QPiR+mc64qtsFMjCDJogi7Lc=' 'sha256-DqxIpMf6VH7z3IRo5FPl7BLJMGHJFUlT6RaxfqKL9CM=' 'sha256-drvwzzeZlOx1+G/oSnkBNO+Ye83xCQdfy85oglVyxGw=' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com https://supabase.rogernortconsult.com; media-src 'self' https://assets.mixkit.co; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests" always;
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "accelerometer=(), autoplay=(self), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()" always;
add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;
add_header X-Permitted-Cross-Domain-Policies "none" always;
# END ROGERNORT MANAGED SECURITY HEADERS
