# BEGIN ROGERNORT MANAGED SECURITY HEADERS
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-6jOTL7MTkWUl8Pdu/p4Rso2JUOGw3qDv2W4gb4D/74w=' 'sha256-plRYK4wQisHlt8eVIh6YJ+dAJtsMu0RuKSNvnuyfuDY=' 'sha256-zJH0txggsA+nxpY4cPvEO80BVsYjwbf4kxob/pJNTrA=' 'sha256-mxib9vaUzc0nwb3FnNQdnyuKKwxs4d0YNs5y9tqrfU4=' 'sha256-QdZVkpljAmnQ7RBgj6358ZM+zT6Q57rZpeVmTAwXR3s=' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com https://supabase.rogernortconsult.com; media-src 'self' https://assets.mixkit.co; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests" always;
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "accelerometer=(), autoplay=(self), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()" always;
add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;
add_header X-Permitted-Cross-Domain-Policies "none" always;
# END ROGERNORT MANAGED SECURITY HEADERS
