/** Dataset descriptions and sample queries shown on the Datasets screen (the data itself is generated in the worker). */
import type { DatasetName } from "./worker/protocol.js";

export interface DatasetInfo { id: DatasetName; title: string; blurb: string; tables: string; samples: { title: string; sql: string }[] }

export const DATASETS: DatasetInfo[] = [
  {
    id: "tpch_mini",
    title: "TPC-H mini",
    blurb: "A scaled-down TPC-H schema: 25 nations, 1,500 customers, 7,500 orders and about 22,000 line items, with indexes on o_custkey, o_orderdate and c_nationkey. Generated with a fixed seed so results are reproducible.",
    tables: "nation, customer, orders, lineitem",
    samples: [
      { title: "Pricing summary (Q1)", sql: "SELECT l_returnflag, count(*) AS n, sum(l_quantity) AS qty, round(sum(l_extendedprice * (1 - l_discount)), 2) AS revenue, round(avg(l_discount), 4) AS avg_disc\nFROM lineitem\nWHERE l_shipdate <= '1998-09-02'\nGROUP BY l_returnflag\nORDER BY l_returnflag" },
      { title: "Top customers by revenue (hash join + aggregate)", sql: "SELECT c.c_name, c.c_mktsegment, count(o.o_orderkey) AS orders, round(sum(o.o_totalprice), 2) AS spent\nFROM customer c JOIN orders o ON o.o_custkey = c.c_custkey\nGROUP BY c.c_custkey\nORDER BY spent DESC\nLIMIT 10" },
      { title: "Three-way join with nation", sql: "SELECT n.n_name, count(DISTINCT c.c_custkey) AS customers, round(sum(l.l_extendedprice * (1 - l.l_discount)), 2) AS revenue\nFROM nation n\nJOIN customer c ON c.c_nationkey = n.n_nationkey\nJOIN orders o ON o.o_custkey = c.c_custkey\nJOIN lineitem l ON l.l_orderkey = o.o_orderkey\nWHERE o.o_orderdate >= '1996-01-01'\nGROUP BY n.n_name\nORDER BY revenue DESC" },
      { title: "Index range scan on order date", sql: "SELECT o_orderdate, count(*) AS n, round(avg(o_totalprice), 2) AS avg_price\nFROM orders\nWHERE o_orderdate BETWEEN '1997-03-01' AND '1997-03-31'\nGROUP BY o_orderdate\nORDER BY o_orderdate" },
      { title: "Window: rank orders within each customer", sql: "SELECT o_custkey, o_orderkey, o_totalprice,\n  rank() OVER (PARTITION BY o_custkey ORDER BY o_totalprice DESC) AS rk,\n  sum(o_totalprice) OVER (PARTITION BY o_custkey ORDER BY o_orderdate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running\nFROM orders\nWHERE o_custkey <= 5\nORDER BY o_custkey, rk" },
    ],
  },
  {
    id: "orders_50k",
    title: "Synthetic orders, 50,000 rows",
    blurb: "One wide table with 50,000 orders across 5,000 customers and five regions, with indexes on customer_id and created_day. Good for watching the planner choose between a sequential scan and an index range scan, and for exercising the virtualised results grid.",
    tables: "orders_50k",
    samples: [
      { title: "Every row (grid virtualisation)", sql: "SELECT * FROM orders_50k ORDER BY id" },
      { title: "Index lookup by customer", sql: "SELECT id, region, status, amount FROM orders_50k WHERE customer_id = 1234 ORDER BY amount DESC" },
      { title: "Group by region and status", sql: "SELECT region, status, count(*) AS n, round(sum(amount), 2) AS total, round(avg(amount), 2) AS avg_amount\nFROM orders_50k\nGROUP BY region, status\nORDER BY region, status" },
      { title: "Top 20 customers, with ranking window", sql: "SELECT customer_id, orders, total, dense_rank() OVER (ORDER BY total DESC) AS rk\nFROM (SELECT customer_id, count(*) AS orders, round(sum(amount), 2) AS total FROM orders_50k GROUP BY customer_id)\nORDER BY rk\nLIMIT 20" },
      { title: "Range scan on day plus correlated subquery", sql: "SELECT o.id, o.created_day, o.amount,\n  (SELECT count(*) FROM orders_50k x WHERE x.customer_id = o.customer_id) AS same_customer\nFROM orders_50k o\nWHERE o.created_day BETWEEN 100 AND 102 AND o.status = 'delivered'\nORDER BY o.amount DESC\nLIMIT 50" },
    ],
  },
  {
    id: "world",
    title: "World: countries and cities",
    blurb: "34 countries with population and GDP, about 300 cities (capitals flagged) and a languages table with a composite primary key. Small enough to read in full and handy for joins, CTEs and set operations.",
    tables: "countries, cities, languages",
    samples: [
      { title: "Largest city per country (window)", sql: "SELECT country, city, population FROM (\n  SELECT c.name AS country, ci.name AS city, ci.population,\n         row_number() OVER (PARTITION BY ci.country_code ORDER BY ci.population DESC) AS rn\n  FROM cities ci JOIN countries c ON c.code = ci.country_code\n) WHERE rn = 1\nORDER BY population DESC" },
      { title: "Continents by population and GDP per capita", sql: "SELECT continent, count(*) AS countries, sum(population) AS population,\n       round(sum(gdp_usd_bn) * 1e9 / sum(population), 0) AS gdp_per_capita\nFROM countries\nGROUP BY continent\nORDER BY population DESC" },
      { title: "Countries whose capital is not their largest city", sql: "SELECT c.name, cap.name AS capital, cap.population AS capital_pop, big.name AS largest, big.population AS largest_pop\nFROM countries c\nJOIN cities cap ON cap.country_code = c.code AND cap.is_capital = 1\nJOIN cities big ON big.country_code = c.code\nWHERE big.population = (SELECT max(population) FROM cities WHERE country_code = c.code)\n  AND big.id <> cap.id\nORDER BY c.name" },
      { title: "Recursive CTE: number series joined to cities", sql: "WITH RECURSIVE buckets(lo) AS (\n  SELECT 0 UNION ALL SELECT lo + 1000000 FROM buckets WHERE lo < 9000000\n)\nSELECT lo AS population_from, lo + 999999 AS population_to, count(ci.id) AS cities\nFROM buckets b LEFT JOIN cities ci ON ci.population >= b.lo AND ci.population < b.lo + 1000000\nGROUP BY lo\nORDER BY lo" },
      { title: "Set operations on languages", sql: "SELECT language FROM languages WHERE is_official = 1\nEXCEPT\nSELECT language FROM languages WHERE country_code = 'USA'\nORDER BY 1" },
    ],
  },
];

/** Fixed benchmark query set (runs against TPC-H mini and the 50k orders table). */
export const BENCH_QUERIES: { name: string; sql: string }[] = [
  { name: "point lookup (rowid)", sql: "SELECT * FROM orders_50k WHERE id = 31337" },
  { name: "index equality", sql: "SELECT count(*) FROM orders_50k WHERE customer_id = 2500" },
  { name: "index range", sql: "SELECT count(*), sum(amount) FROM orders_50k WHERE created_day BETWEEN 200 AND 230" },
  { name: "seq scan + filter", sql: "SELECT count(*) FROM orders_50k WHERE amount > 400 AND status = 'paid'" },
  { name: "group by 25 groups", sql: "SELECT region, status, count(*), sum(amount) FROM orders_50k GROUP BY region, status" },
  { name: "group by 5k groups", sql: "SELECT customer_id, count(*), sum(amount) FROM orders_50k GROUP BY customer_id" },
  { name: "order by + limit (top-k)", sql: "SELECT id, amount FROM orders_50k ORDER BY amount DESC LIMIT 10" },
  { name: "full sort 50k", sql: "SELECT id FROM orders_50k ORDER BY amount" },
  { name: "hash join 1.5k x 7.5k", sql: "SELECT c.c_mktsegment, count(*) FROM customer c JOIN orders o ON o.o_custkey = c.c_custkey GROUP BY c.c_mktsegment" },
  { name: "3-way join + aggregate", sql: "SELECT n.n_name, sum(l.l_extendedprice) FROM nation n JOIN customer c ON c.c_nationkey = n.n_nationkey JOIN orders o ON o.o_custkey = c.c_custkey JOIN lineitem l ON l.l_orderkey = o.o_orderkey GROUP BY n.n_name" },
  { name: "window over 7.5k rows", sql: "SELECT o_orderkey, rank() OVER (PARTITION BY o_custkey ORDER BY o_totalprice DESC) FROM orders" },
  { name: "recursive CTE 10k steps", sql: "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 10000) SELECT count(*) FROM s" },
];
