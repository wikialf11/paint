# PAINT!

Lienzo casi infinito (2.000.001 × 2.000.001 cuadros) donde todo el mundo pinta a la vez en blanco y negro.
La pintura negra es un bote compartido por todos: pintar un cuadro gasta 1, volverlo blanco devuelve 1.

- Frontend estático (HTML + JS, sin compilación): `index.html`, `app.js`, `style.css`.
- Backend: Supabase (Postgres + Realtime). Esquema en `supabase/schema.sql`.
  Las escrituras solo pasan por la función `toggle_cell()`, que bloquea la fila del bote y es atómica.
- Publicidad: huecos de Google AdSense en `index.html` (busca `ca-pub-XXXXXXXXXXXXXXXX`) y `ads.txt`.

## Cambiar el tamaño del bote

```sql
update pool set total = total + 5000, remaining = remaining + 5000 where id = 1;
```
