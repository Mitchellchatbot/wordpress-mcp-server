<?php
/**
 * Plugin Name: Elementor Submissions REST API
 * Description: Exposes Elementor Pro form submissions via the WordPress REST API for Claude MCP integration.
 * Version: 1.0.0
 * Author: Claude MCP
 */

if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'rest_api_init', function () {

    // List all form submissions (with optional filtering)
    register_rest_route( 'custom/v1', '/form-submissions', [
        'methods'             => 'GET',
        'callback'            => 'mcp_get_form_submissions',
        'permission_callback' => 'mcp_check_auth',
        'args'                => [
            'per_page' => [
                'default'           => 20,
                'sanitize_callback' => 'absint',
            ],
            'page' => [
                'default'           => 1,
                'sanitize_callback' => 'absint',
            ],
            'form_name' => [
                'default'           => '',
                'sanitize_callback' => 'sanitize_text_field',
            ],
            'search' => [
                'default'           => '',
                'sanitize_callback' => 'sanitize_text_field',
            ],
            'after' => [
                'default'           => '',
                'sanitize_callback' => 'sanitize_text_field',
            ],
        ],
    ] );

    // Get a single submission by ID
    register_rest_route( 'custom/v1', '/form-submissions/(?P<id>\d+)', [
        'methods'             => 'GET',
        'callback'            => 'mcp_get_single_submission',
        'permission_callback' => 'mcp_check_auth',
    ] );

    // List all unique form names (useful for filtering)
    register_rest_route( 'custom/v1', '/form-names', [
        'methods'             => 'GET',
        'callback'            => 'mcp_get_form_names',
        'permission_callback' => 'mcp_check_auth',
    ] );

} );

/**
 * Auth check — requires the same WordPress Application Password used by the MCP server.
 * Logged-in administrators pass automatically.
 */
function mcp_check_auth( WP_REST_Request $request ) {
    return current_user_can( 'manage_options' );
}

/**
 * List submissions from wp_e_submissions + wp_e_submission_values
 */
function mcp_get_form_submissions( WP_REST_Request $request ) {
    global $wpdb;

    $per_page  = (int) $request->get_param( 'per_page' );
    $page      = (int) $request->get_param( 'page' );
    $form_name = $request->get_param( 'form_name' );
    $search    = $request->get_param( 'search' );
    $after     = $request->get_param( 'after' );
    $offset    = ( $page - 1 ) * $per_page;

    $submissions_table = $wpdb->prefix . 'e_submissions';
    $values_table      = $wpdb->prefix . 'e_submission_values';

    // Check table exists
    if ( $wpdb->get_var( "SHOW TABLES LIKE '$submissions_table'" ) !== $submissions_table ) {
        return new WP_Error(
            'no_table',
            'Elementor submissions table not found. Make sure Elementor Pro is installed and has received at least one form submission.',
            [ 'status' => 404 ]
        );
    }

    // Build WHERE clauses
    $where   = [];
    $prepare = [];

    if ( $form_name ) {
        $where[]   = 'form_name = %s';
        $prepare[] = $form_name;
    }

    if ( $after ) {
        $where[]   = 'created_at > %s';
        $prepare[] = $after;
    }

    $where_sql = $where ? 'WHERE ' . implode( ' AND ', $where ) : '';

    // Get total count
    $count_sql = "SELECT COUNT(*) FROM $submissions_table $where_sql";
    $total     = $prepare
        ? (int) $wpdb->get_var( $wpdb->prepare( $count_sql, ...$prepare ) )
        : (int) $wpdb->get_var( $count_sql );

    // Get submissions
    $prepare_paginated   = array_merge( $prepare, [ $per_page, $offset ] );
    $submissions_sql     = "SELECT * FROM $submissions_table $where_sql ORDER BY created_at DESC LIMIT %d OFFSET %d";
    $submissions         = $wpdb->prepare
        ? $wpdb->get_results( $wpdb->prepare( $submissions_sql, ...$prepare_paginated ) )
        : $wpdb->get_results( $submissions_sql );

    if ( empty( $submissions ) ) {
        return rest_ensure_response( [
            'total'       => 0,
            'pages'       => 0,
            'submissions' => [],
        ] );
    }

    // Fetch field values for all returned submissions
    $ids         = array_map( fn( $s ) => (int) $s->id, $submissions );
    $ids_in      = implode( ',', $ids );
    $values_rows = $wpdb->get_results( "SELECT * FROM $values_table WHERE submission_id IN ($ids_in)" );

    // Group values by submission_id
    $values_by_id = [];
    foreach ( $values_rows as $v ) {
        $values_by_id[ $v->submission_id ][ $v->key ] = $v->value;
    }

    // Build response
    $results = [];
    foreach ( $submissions as $sub ) {
        $fields = $values_by_id[ $sub->id ] ?? [];

        // Apply search filter on field values
        if ( $search ) {
            $haystack = strtolower( implode( ' ', $fields ) );
            if ( strpos( $haystack, strtolower( $search ) ) === false ) {
                continue;
            }
        }

        $results[] = [
            'id'         => (int) $sub->id,
            'form_name'  => $sub->form_name,
            'page_title' => $sub->page_title ?? '',
            'page_url'   => $sub->referer ?? '',
            'status'     => $sub->status ?? 'unread',
            'created_at' => $sub->created_at,
            'fields'     => $fields,
        ];
    }

    return rest_ensure_response( [
        'total'       => $total,
        'pages'       => ceil( $total / $per_page ),
        'page'        => $page,
        'submissions' => $results,
    ] );
}

/**
 * Single submission by ID
 */
function mcp_get_single_submission( WP_REST_Request $request ) {
    global $wpdb;

    $id                = (int) $request->get_param( 'id' );
    $submissions_table = $wpdb->prefix . 'e_submissions';
    $values_table      = $wpdb->prefix . 'e_submission_values';

    $sub = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $submissions_table WHERE id = %d", $id ) );

    if ( ! $sub ) {
        return new WP_Error( 'not_found', 'Submission not found.', [ 'status' => 404 ] );
    }

    $values = $wpdb->get_results( $wpdb->prepare( "SELECT `key`, value FROM $values_table WHERE submission_id = %d", $id ) );
    $fields = [];
    foreach ( $values as $v ) {
        $fields[ $v->key ] = $v->value;
    }

    // Mark as read
    $wpdb->update( $submissions_table, [ 'status' => 'read' ], [ 'id' => $id ] );

    return rest_ensure_response( [
        'id'         => (int) $sub->id,
        'form_name'  => $sub->form_name,
        'page_title' => $sub->page_title ?? '',
        'page_url'   => $sub->referer ?? '',
        'status'     => $sub->status ?? 'unread',
        'created_at' => $sub->created_at,
        'fields'     => $fields,
    ] );
}

/**
 * List all unique form names
 */
function mcp_get_form_names( WP_REST_Request $request ) {
    global $wpdb;

    $table = $wpdb->prefix . 'e_submissions';

    if ( $wpdb->get_var( "SHOW TABLES LIKE '$table'" ) !== $table ) {
        return new WP_Error( 'no_table', 'Elementor submissions table not found.', [ 'status' => 404 ] );
    }

    $names = $wpdb->get_col( "SELECT DISTINCT form_name FROM $table ORDER BY form_name ASC" );

    return rest_ensure_response( [ 'form_names' => $names ] );
}
