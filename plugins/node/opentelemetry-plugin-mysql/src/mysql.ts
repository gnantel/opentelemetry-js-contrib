/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BasePlugin, isWrapped } from '@opentelemetry/core';
import { CanonicalCode, Span, SpanKind } from '@opentelemetry/api';
import type * as mysqlTypes from 'mysql';
import * as shimmer from 'shimmer';
import { getConnectionAttributes, getDbStatement, getSpanName } from './utils';
import { VERSION } from './version';
import { DatabaseAttribute } from '@opentelemetry/semantic-conventions';

export class MysqlPlugin extends BasePlugin<typeof mysqlTypes> {
  readonly supportedVersions = ['2.*'];

  static readonly COMPONENT = 'mysql';

  static readonly COMMON_ATTRIBUTES = {
    [DatabaseAttribute.DB_SYSTEM]: MysqlPlugin.COMPONENT,
  };

  private _enabled = false;

  constructor(readonly moduleName: string) {
    super('@opentelemetry/plugin-mysql', VERSION);
  }

  protected patch(): typeof mysqlTypes {
    this._enabled = true;
    shimmer.wrap(
      this._moduleExports,
      'createConnection',
      this._patchCreateConnection() as any
    );

    shimmer.wrap(
      this._moduleExports,
      'createPool',
      this._patchCreatePool() as any
    );

    shimmer.wrap(
      this._moduleExports,
      'createPoolCluster',
      this._patchCreatePoolCluster() as any
    );

    return this._moduleExports;
  }

  protected unpatch(): void {
    this._enabled = false;
    shimmer.unwrap(this._moduleExports, 'createConnection');
    shimmer.unwrap(this._moduleExports, 'createPool');
    shimmer.unwrap(this._moduleExports, 'createPoolCluster');
  }

  // global export function
  private _patchCreateConnection() {
    return (originalCreateConnection: Function) => {
      const thisPlugin = this;
      thisPlugin._logger.debug(
        'MysqlPlugin#patch: patched mysql createConnection'
      );

      return function createConnection(
        _connectionUri: string | mysqlTypes.ConnectionConfig
      ) {
        const originalResult = originalCreateConnection(...arguments);

        // This is unwrapped on next call after unpatch
        shimmer.wrap(
          originalResult,
          'query',
          thisPlugin._patchQuery(originalResult) as any
        );

        return originalResult;
      };
    };
  }

  // global export function
  private _patchCreatePool() {
    return (originalCreatePool: Function) => {
      const thisPlugin = this;
      thisPlugin._logger.debug('MysqlPlugin#patch: patched mysql createPool');
      return function createPool(_config: string | mysqlTypes.PoolConfig) {
        const pool = originalCreatePool(...arguments);

        shimmer.wrap(pool, 'query', thisPlugin._patchQuery(pool));
        shimmer.wrap(
          pool,
          'getConnection',
          thisPlugin._patchGetConnection(pool)
        );

        return pool;
      };
    };
  }

  // global export function
  private _patchCreatePoolCluster() {
    return (originalCreatePoolCluster: Function) => {
      const thisPlugin = this;
      thisPlugin._logger.debug(
        'MysqlPlugin#patch: patched mysql createPoolCluster'
      );
      return function createPool(_config: string | mysqlTypes.PoolConfig) {
        const cluster = originalCreatePoolCluster(...arguments);

        // This is unwrapped on next call after unpatch
        shimmer.wrap(
          cluster,
          'getConnection',
          thisPlugin._patchGetConnection(cluster)
        );

        return cluster;
      };
    };
  }

  // method on cluster or pool
  private _patchGetConnection(pool: mysqlTypes.Pool | mysqlTypes.PoolCluster) {
    return (originalGetConnection: Function) => {
      const thisPlugin = this;
      thisPlugin._logger.debug(
        'MysqlPlugin#patch: patched mysql pool getConnection'
      );
      return function getConnection(
        arg1?: unknown,
        arg2?: unknown,
        arg3?: unknown
      ) {
        // Unwrap if unpatch has been called
        if (!thisPlugin._enabled) {
          shimmer.unwrap(pool, 'getConnection');
          return originalGetConnection.apply(pool, arguments);
        }

        if (arguments.length === 1 && typeof arg1 === 'function') {
          const patchFn = thisPlugin._getConnectionCallbackPatchFn(arg1);
          return originalGetConnection.call(pool, patchFn);
        }
        if (arguments.length === 2 && typeof arg2 === 'function') {
          const patchFn = thisPlugin._getConnectionCallbackPatchFn(arg2);
          return originalGetConnection.call(pool, arg1, patchFn);
        }
        if (arguments.length === 3 && typeof arg3 === 'function') {
          const patchFn = thisPlugin._getConnectionCallbackPatchFn(arg3);
          return originalGetConnection.call(pool, arg1, arg2, patchFn);
        }

        return originalGetConnection.apply(pool, arguments);
      };
    };
  }

  private _getConnectionCallbackPatchFn(cb: Function) {
    const thisPlugin = this;
    return function () {
      if (arguments[1]) {
        // this is the callback passed into a query
        // no need to unwrap
        if (!isWrapped(arguments[1].query)) {
          shimmer.wrap(
            arguments[1],
            'query',
            thisPlugin._patchQuery(arguments[1])
          );
        }
      }
      if (typeof cb === 'function') {
        cb(...arguments);
      }
    };
  }

  private _patchQuery(connection: mysqlTypes.Connection | mysqlTypes.Pool) {
    return (originalQuery: Function): mysqlTypes.QueryFunction => {
      const thisPlugin = this;
      thisPlugin._logger.debug('MysqlPlugin: patched mysql query');

      const format = this._moduleExports.format;

      return function query(
        query: string | mysqlTypes.Query | mysqlTypes.QueryOptions,
        _valuesOrCallback?: unknown[] | mysqlTypes.queryCallback,
        _callback?: mysqlTypes.queryCallback
      ) {
        if (!thisPlugin._enabled) {
          shimmer.unwrap(connection, 'query');
          return originalQuery.apply(connection, arguments);
        }

        const span = thisPlugin._tracer.startSpan(getSpanName(query), {
          kind: SpanKind.CLIENT,
          attributes: {
            ...MysqlPlugin.COMMON_ATTRIBUTES,
            ...getConnectionAttributes(connection.config),
          },
        });

        let values;

        if (Array.isArray(_valuesOrCallback)) {
          values = _valuesOrCallback;
        } else if (arguments[2]) {
          values = [_valuesOrCallback];
        }

        span.setAttribute(
          DatabaseAttribute.DB_STATEMENT,
          getDbStatement(query, format, values)
        );

        if (arguments.length === 1) {
          const streamableQuery: mysqlTypes.Query = originalQuery.apply(
            connection,
            arguments
          );

          return streamableQuery
            .on('error', err =>
              span.setStatus({
                code: CanonicalCode.UNKNOWN,
                message: err.message,
              })
            )
            .on('end', () => {
              span.end();
            });
        }

        if (typeof arguments[1] === 'function') {
          shimmer.wrap(arguments, 1, thisPlugin._patchCallbackQuery(span));
        } else if (typeof arguments[2] === 'function') {
          shimmer.wrap(arguments, 2, thisPlugin._patchCallbackQuery(span));
        }

        return originalQuery.apply(connection, arguments);
      };
    };
  }

  private _patchCallbackQuery(span: Span) {
    return (originalCallback: Function) => {
      return function (
        err: mysqlTypes.MysqlError | null,
        results?: any,
        fields?: mysqlTypes.FieldInfo[]
      ) {
        if (err) {
          span.setStatus({
            code: CanonicalCode.UNKNOWN,
            message: err.message,
          });
        } else {
          span.setStatus({
            code: CanonicalCode.OK,
          });
        }
        span.end();
        return originalCallback(...arguments);
      };
    };
  }
}

export const plugin = new MysqlPlugin(MysqlPlugin.COMPONENT);
